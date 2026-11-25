'use strict';

/**
 * SwiftShell recursive-descent parser.
 *
 * The AST is deliberately plain JSON data: every node has a `type`, source
 * position (`line`, `column`) and only serialisable children. That makes
 * `--ast` dumps useful and keeps the interpreter independent of token objects.
 *
 * Grammar (informal; see README for the documented version):
 *
 *   program      := statement*
 *   statement    := ( let | if | for | while | fn | return | break | continue
 *                   | expression | pipeline ) ( (';' | '&&') statement )?
 *   let          := 'let' IDENT '=' expression
 *   assignment   := IDENT '=' expression
 *   if           := 'if' '('? expression ')'? block ('else' (if | block))?
 *   for          := 'for' IDENT 'in' expression block
 *   while        := 'while' expression block
 *   fn           := 'fn' IDENT '(' IDENT (',' IDENT)* ')' block
 *   block        := '{' statement* '}'
 *   pipeline     := command ('|' command)*
 *   command      := word* redirection?
 *   redirection  := ('>' | '>>') expression
 *   expression   := IDENT '=' expression | logical-and
 *   logical-and  := equality ('&&' equality)*
 *   equality     := comparison (('==' | '!=') comparison)*
 *   comparison   := additive (('<' | '>' | '<=' | '>=') additive)*
 *   additive     := multiplicative (('+' | '-') multiplicative)*
 *   multiplicative := unary (('*' | '/' | '%') unary)*
 *   unary        := ('!' | '-') unary | postfix
 *   postfix      := primary ('.' IDENT ('(' args? ')')?)*
 *   primary      := NUMBER | STRING | IDENT | IDENT '(' args? ')'
 *                 | '(' expression ')' | '[' args? ']' | '$(' pipeline ')'
 *   args         := expression (',' expression)*
 */

const { tokenize, TOKEN } = require('./lexer');

const KEYWORDS = new Set(['let', 'if', 'else', 'for', 'in', 'while', 'fn', 'return', 'break', 'continue']);
const ASSIGNMENT_OPS = new Set(['=']);
const LOGICAL_OPS = new Set(['&&']);
const EQUALITY_OPS = new Set(['==', '!=']);
const COMPARISON_OPS = new Set(['<', '>', '<=', '>=']);
const ADDITIVE_OPS = new Set(['+', '-']);
const MULTIPLICATIVE_OPS = new Set(['*', '/', '%']);
const BINARY_OP_VALUES = new Set([
  ...LOGICAL_OPS, ...EQUALITY_OPS, ...COMPARISON_OPS, ...ADDITIVE_OPS, ...MULTIPLICATIVE_OPS,
]);

/** Parse error with source coordinates. */
class ParserError extends SyntaxError {
  constructor(message, line, column) {
    super(`${message} (line ${line}, column ${column})`);
    this.name = 'SyntaxError';
    this.line = line;
    this.column = column;
  }
}

class Parser {
  constructor(tokens) {
    if (!Array.isArray(tokens) || tokens.length === 0) {
      throw new TypeError('Parser expects a non-empty token array');
    }
    this.tokens = tokens;
    this.index = 0;
  }

  /** Current token (or EOF when past the end). */
  peek(offset = 0) {
    const index = Math.min(this.index + offset, this.tokens.length - 1);
    return this.tokens[index];
  }

  at(type, value) {
    const token = this.peek();
    return token.type === type && (value === undefined || token.value === value);
  }

  atOp(...values) {
    const token = this.peek();
    return token.type === TOKEN.OP && values.includes(token.value);
  }

  consume() {
    const token = this.peek();
    if (token.type !== TOKEN.EOF) this.index += 1;
    return token;
  }

  match(type, value) {
    if (this.at(type, value)) return this.consume();
    return null;
  }

  matchOp(...values) {
    if (this.atOp(...values)) return this.consume();
    return null;
  }

  error(message, token = this.peek()) {
    throw new ParserError(message, token.line, token.column);
  }

  expect(type, value, label) {
    const token = this.peek();
    if (token.type !== type || (value !== undefined && token.value !== value)) {
      const expected = label || (value !== undefined ? JSON.stringify(value) : type);
      this.error(`Expected ${expected}, found ${describeToken(token)}`, token);
    }
    return this.consume();
  }

  /** Newlines are ignored where the grammar permits line breaks. */
  skipNewlines() {
    while (this.at(TOKEN.NEWLINE)) this.consume();
  }

  /** Consume optional line breaks after a separator such as '|' or ','. */
  skipLayout() {
    while (this.at(TOKEN.NEWLINE)) this.consume();
  }

  parseProgram() {
    const start = this.peek();
    const body = [];
    this.skipNewlines();
    while (!this.at(TOKEN.EOF)) {
      body.push(this.parseStatement());
      this.skipNewlines();
      while (this.match(TOKEN.PUNCT, ';')) this.skipNewlines();
    }
    return node('Program', start, { body });
  }

  /**
   * Parse a statement plus any `;` / `&&` separated statements. `&&` is
   * represented as an 'and' step so the interpreter can short-circuit.
   */
  parseStatement() {
    const first = this.parseStatementCore();
    if (!this.at(TOKEN.PUNCT, ';') && !this.atOp('&&')) return first;

    const steps = [{ op: 'seq', statement: first }];
    while (this.at(TOKEN.PUNCT, ';') || this.atOp('&&')) {
      const separator = this.consume();
      if (this.at(TOKEN.EOF) || this.at(TOKEN.PUNCT, '}')) break; // trailing separator
      const op = separator.value === '&&' ? 'and' : 'seq';
      this.skipLayout();
      steps.push({ op, statement: this.parseStatementCore() });
    }
    return steps.length === 1 ? first : node('Chain', first, { steps });
  }

  parseStatementCore() {
    const start = this.peek();

    if (this.at(TOKEN.IDENT, 'let')) return this.parseLet();
    if (this.at(TOKEN.IDENT, 'if')) return this.parseIf();
    if (this.at(TOKEN.IDENT, 'for')) return this.parseFor();
    if (this.at(TOKEN.IDENT, 'while')) return this.parseWhile();
    if (this.at(TOKEN.IDENT, 'fn')) return this.parseFunction();
    if (this.at(TOKEN.IDENT, 'return')) return this.parseReturn();
    if (this.at(TOKEN.IDENT, 'break')) {
      this.consume();
      return node('Break', start, {});
    }
    if (this.at(TOKEN.IDENT, 'continue')) {
      this.consume();
      return node('Continue', start, {});
    }

    if (this.looksLikeExpressionStatement()) {
      return this.parseExpression();
    }
    return this.parsePipeline();
  }

  /**
   * Decide whether a statement starts with an expression or with a command.
   * `echo hello` is a command (IDENT followed by another word), while
   * `x = 1`, `f(1)`, `x + 2` and `[1, 2]` are expressions.
   */
  looksLikeExpressionStatement() {
    const first = this.peek();
    const second = this.peek(1);
    if (first.type === TOKEN.NUMBER || first.type === TOKEN.STRING) return true;
    if (first.type === TOKEN.PUNCT && ['(', '[', '$('].includes(first.value)) return true;
    if (first.type === TOKEN.OP && ['!', '-'].includes(first.value)) return true;
    if (first.type === TOKEN.IDENT) {
      if (KEYWORDS.has(first.value)) return true;
      // Assignment and comparisons unambiguously start expressions. Plain
      // arithmetic operators are left to the command grammar so that flags
      // such as `mkdir -p` and `ls -la` keep working.
      if (second.type === TOKEN.OP && (
        ASSIGNMENT_OPS.has(second.value) || LOGICAL_OPS.has(second.value)
        || EQUALITY_OPS.has(second.value) || COMPARISON_OPS.has(second.value)
      )) return true;
      if (second.type === TOKEN.PUNCT && second.value === '(') return true;
      if (second.type === TOKEN.PUNCT && second.value === '.') return true;
    }
    return false;
  }

  parseLet() {
    const start = this.expect(TOKEN.IDENT, 'let');
    const name = this.expect(TOKEN.IDENT, undefined, 'a variable name');
    this.expect(TOKEN.OP, '=');
    const value = this.parseExpression();
    return node('Let', start, { name: name.value, value });
  }

  parseIf() {
    const start = this.expect(TOKEN.IDENT, 'if');
    const parenthesised = Boolean(this.match(TOKEN.PUNCT, '('));
    this.skipLayout();
    const test = this.parseExpression();
    this.skipLayout();
    if (parenthesised) this.expect(TOKEN.PUNCT, ')', "')'");
    const consequent = this.parseBlock();
    let alternate = null;
    this.skipNewlines();
    if (this.at(TOKEN.IDENT, 'else')) {
      this.consume();
      this.skipNewlines();
      if (this.at(TOKEN.IDENT, 'if')) alternate = this.parseIf();
      else alternate = this.parseBlock();
    }
    return node('If', start, { test, consequent, alternate });
  }

  parseFor() {
    const start = this.expect(TOKEN.IDENT, 'for');
    const name = this.expect(TOKEN.IDENT, undefined, 'a loop variable name');
    this.expect(TOKEN.IDENT, 'in');
    const iterable = this.parseExpression();
    this.skipLayout();
    const body = this.parseBlock();
    return node('For', start, { name: name.value, iterable, body });
  }

  parseWhile() {
    const start = this.expect(TOKEN.IDENT, 'while');
    const test = this.parseExpression();
    this.skipLayout();
    const body = this.parseBlock();
    return node('While', start, { test, body });
  }

  parseFunction() {
    const start = this.expect(TOKEN.IDENT, 'fn');
    const name = this.expect(TOKEN.IDENT, undefined, 'a function name');
    this.expect(TOKEN.PUNCT, '(');
    const params = [];
    this.skipLayout();
    if (!this.at(TOKEN.PUNCT, ')')) {
      for (;;) {
        params.push(this.expect(TOKEN.IDENT, undefined, 'a parameter name').value);
        this.skipLayout();
        if (!this.match(TOKEN.PUNCT, ',')) break;
        this.skipLayout();
      }
    }
    this.expect(TOKEN.PUNCT, ')', "')'");
    const body = this.parseBlock();
    return node('FunctionDecl', start, { name: name.value, params, body });
  }

  parseReturn() {
    const start = this.expect(TOKEN.IDENT, 'return');
    const next = this.peek();
    const endsStatement =
      next.type === TOKEN.NEWLINE || next.type === TOKEN.EOF ||
      (next.type === TOKEN.PUNCT && ['}', ';'].includes(next.value));
    const value = endsStatement ? null : this.parseExpression();
    return node('Return', start, { value });
  }

  parseBlock() {
    const start = this.expect(TOKEN.PUNCT, '{', "'{'");
    const body = [];
    this.skipNewlines();
    while (!this.at(TOKEN.PUNCT, '}')) {
      if (this.at(TOKEN.EOF)) this.error("Expected '}' to close block", start);
      body.push(this.parseStatement());
      this.skipNewlines();
      while (this.match(TOKEN.PUNCT, ';')) this.skipNewlines();
    }
    this.expect(TOKEN.PUNCT, '}', "'}'");
    return node('Block', start, { body });
  }

  /** Parse one or more commands joined by '|'. */
  parsePipeline() {
    const commands = [this.parseCommand()];
    while (this.match(TOKEN.PUNCT, '|')) {
      this.skipLayout();
      if (this.at(TOKEN.EOF) || this.at(TOKEN.PUNCT, '}')) {
        this.error("Expected a command after '|'");
      }
      commands.push(this.parseCommand());
    }
    if (commands.length === 1) return commands[0];
    return node('Pipeline', commands[0], { commands });
  }

  /** Parse a command: zero or more words, optionally redirected. */
  parseCommand() {
    const start = this.peek();
    const words = [];
    let redirect = null;

    while (this.canStartWord()) {
      words.push(this.parseWord());
      if (this.atOp('>') || this.at(TOKEN.PUNCT, '>>')) {
        const op = this.consume();
        if (!this.canStartWord()) this.error('Expected a target after redirection', op);
        redirect = {
          op: op.value,
          target: this.parseWord(),
          line: op.line,
          column: op.column,
        };
      }
    }

    if (words.length === 0 && !redirect) {
      this.error(`Expected a command, found ${describeToken(this.peek())}`, this.peek());
    }
    return node('Command', start, { words: normalizeFlagWords(words), redirect });
  }

  /** Tokens that may begin a command word. `>` and `&&` are excluded. */
  canStartWord() {
    const token = this.peek();
    if (token.type === TOKEN.NUMBER || token.type === TOKEN.STRING || token.type === TOKEN.IDENT) return true;
    if (token.type === TOKEN.PUNCT && ['[', '(', '$('].includes(token.value)) return true;
    if (token.type === TOKEN.OP && !['>', '&&', '='].includes(token.value)) return true;
    return false;
  }

  /**
   * Join path-like words (`out.txt`, `dir/file`, `/tmp/file`, `./script.shs`)
   * into one literal. Without this, `/` would be parsed as a separate command
   * word and redirection targets such as `logs/out.txt` would break.
   * Only adjacent tokens are joined, so arithmetic `1 / 2` stays untouched.
   */
  tryParsePathWord() {
    const first = this.peek();
    if (!isPathToken(first)) return null;
    const parts = [wordText(first)];
    let previous = first;
    let cursor = 1;
    while (isPathToken(this.peek(cursor)) && adjacentTokens(previous, this.peek(cursor))) {
      const token = this.peek(cursor);
      parts.push(wordText(token));
      previous = token;
      cursor += 1;
    }
    const text = parts.join('');
    if (!text.includes('/')) return null;
    for (let i = 0; i < parts.length; i += 1) this.consume();
    return node('Literal', first, { value: text, raw: text });
  }

  /** A command word is a primary expression (no top-level binary operators). */
  parseWord() {
    const token = this.peek();
    const path = this.tryParsePathWord();
    if (path) return path;
    // `file.txt` and `path/to/file` are ordinary words, not method calls.
    // Only treat `value.method(...)` as member sugar when a '(' follows.
    if (token.type === TOKEN.IDENT && this.peek(1).type === TOKEN.PUNCT && this.peek(1).value === '.') {
      const parts = [token.value];
      let offset = 0;
      while (
        this.peek(offset + 1).type === TOKEN.PUNCT && this.peek(offset + 1).value === '.'
        && this.peek(offset + 2).type === TOKEN.IDENT
      ) {
        offset += 2;
        parts.push(this.peek(offset).value);
      }
      const after = this.peek(offset + 1);
      if (!(after.type === TOKEN.PUNCT && after.value === '(')) {
        for (let i = 0; i <= offset; i += 1) this.consume();
        return node('Literal', token, { value: parts.join('.'), raw: parts.join('.') });
      }
    }
    if (token.type === TOKEN.OP) {
      // Bare operator tokens (e.g. `-n`, `+`) are passed through as strings.
      this.consume();
      return node('Literal', token, { value: token.value, raw: token.value });
    }
    const word = this.parsePostfix();
    // An unresolved bare identifier in a command is the literal word (like a
    // shell), whereas an unresolved identifier in an expression is an error.
    if (word.type === 'Variable') word.bare = true;
    return word;
  }

  // ---- Expressions -------------------------------------------------------

  parseExpression() {
    const start = this.peek();
    if (this.at(TOKEN.IDENT) && this.peek(1).type === TOKEN.OP && this.peek(1).value === '=') {
      const name = this.consume();
      this.consume(); // '='
      const value = this.parseExpression();
      return node('Assign', start, { name: name.value, value });
    }
    return this.parseLogicalAnd();
  }

  parseLogicalAnd() {
    let left = this.parseEquality();
    while (this.atOp(...LOGICAL_OPS)) {
      const op = this.consume();
      const right = this.parseEquality();
      left = node('Binary', op, { op: op.value, left, right });
    }
    return left;
  }

  parseEquality() {
    let left = this.parseComparison();
    while (this.atOp(...EQUALITY_OPS)) {
      const op = this.consume();
      const right = this.parseComparison();
      left = node('Binary', op, { op: op.value, left, right });
    }
    return left;
  }

  parseComparison() {
    let left = this.parseAdditive();
    while (this.atOp(...COMPARISON_OPS)) {
      const op = this.consume();
      const right = this.parseAdditive();
      left = node('Binary', op, { op: op.value, left, right });
    }
    return left;
  }

  parseAdditive() {
    let left = this.parseMultiplicative();
    while (this.atOp(...ADDITIVE_OPS)) {
      const op = this.consume();
      const right = this.parseMultiplicative();
      left = node('Binary', op, { op: op.value, left, right });
    }
    return left;
  }

  parseMultiplicative() {
    let left = this.parseUnary();
    while (this.atOp(...MULTIPLICATIVE_OPS)) {
      const op = this.consume();
      const right = this.parseUnary();
      left = node('Binary', op, { op: op.value, left, right });
    }
    return left;
  }

  parseUnary() {
    const token = this.peek();
    if (this.atOp('!', '-')) {
      this.consume();
      const argument = this.parseUnary();
      return node('Unary', token, { op: token.value, argument });
    }
    return this.parsePostfix();
  }

  parsePostfix() {
    let expression = this.parsePrimary();
    while (this.at(TOKEN.PUNCT, '.')) {
      const dot = this.consume();
      const property = this.expect(TOKEN.IDENT, undefined, 'a method/property name');
      // Method sugar: `value.method(args)` is compiled to
      // Call(Member(object, method), args). The interpreter passes `object`
      // as the first argument to the builtin.
      expression = node('Member', dot, { object: expression, property: property.value });
      if (this.match(TOKEN.PUNCT, '(')) {
        const args = this.parseArguments();
        expression = node('Call', dot, { callee: expression, args });
      }
    }
    // Indexing: array[0], string[1], object["key"]. Negative indices count
    // from the end for arrays and strings.
    while (this.at(TOKEN.PUNCT, '[')) {
      const bracket = this.consume();
      const index = this.parseExpression();
      this.expect(TOKEN.PUNCT, ']', "']'");
      expression = node('Index', bracket, { object: expression, index });
    }
    return expression;
  }

  parseArguments() {
    const args = [];
    this.skipLayout();
    if (!this.at(TOKEN.PUNCT, ')')) {
      for (;;) {
        args.push(this.parseExpression());
        this.skipLayout();
        if (!this.match(TOKEN.PUNCT, ',')) break;
        this.skipLayout();
      }
    }
    this.expect(TOKEN.PUNCT, ')', "')'");
    return args;
  }

  parsePrimary() {
    const token = this.peek();

    if (token.type === TOKEN.NUMBER) {
      this.consume();
      return node('Literal', token, { value: token.value, raw: token.raw, numberKind: token.kind });
    }
    if (token.type === TOKEN.STRING) {
      this.consume();
      return node('String', token, { parts: token.parts });
    }
    if (token.type === TOKEN.IDENT) {
      this.consume();
      if (token.value === 'true' || token.value === 'false' || token.value === 'null') {
        const literal = token.value === 'null' ? null : token.value === 'true';
        return node('Literal', token, { value: literal, raw: token.value });
      }
      const callee = node('Variable', token, { name: token.value, bare: false });
      if (this.match(TOKEN.PUNCT, '(')) {
        const args = this.parseArguments();
        return node('Call', token, { callee, args });
      }
      return callee;
    }
    if (this.at(TOKEN.PUNCT, '(')) {
      this.consume();
      this.skipLayout();
      const expression = this.parseExpression();
      this.skipLayout();
      this.expect(TOKEN.PUNCT, ')', "')'");
      return expression;
    }
    if (this.at(TOKEN.PUNCT, '[')) {
      this.consume();
      const elements = [];
      this.skipLayout();
      if (!this.at(TOKEN.PUNCT, ']')) {
        for (;;) {
          elements.push(this.parseExpression());
          this.skipLayout();
          if (!this.match(TOKEN.PUNCT, ',')) break;
          this.skipLayout();
        }
      }
      this.expect(TOKEN.PUNCT, ']', "']'");
      return node('Array', token, { elements });
    }
    if (this.at(TOKEN.PUNCT, '$(')) {
      this.consume();
      this.skipLayout();
      if (this.at(TOKEN.PUNCT, ')')) this.error('Empty command substitution', token);
      const body = this.parseCommandGroup();
      this.skipLayout();
      this.expect(TOKEN.PUNCT, ')', "')' to close command substitution");
      return node('CommandSubstitution', token, { body });
    }

    this.error(`Unexpected token ${describeToken(token)} in expression`, token);
  }

  /**
   * Parse the command(s) inside `$(...)`. Supports pipelines and `;`/`&&`
   * separators, and stops naturally at the closing ')'.
   */
  parseCommandGroup() {
    const first = this.parsePipeline();
    if (!this.at(TOKEN.PUNCT, ';') && !this.atOp('&&')) return first;
    const steps = [{ op: 'seq', statement: first }];
    while (this.at(TOKEN.PUNCT, ';') || this.atOp('&&')) {
      const separator = this.consume();
      const op = separator.value === '&&' ? 'and' : 'seq';
      this.skipLayout();
      if (this.at(TOKEN.PUNCT, ')')) this.error('Expected a command after separator', separator);
      steps.push({ op, statement: this.parsePipeline() });
    }
    return node('Chain', first, { steps });
  }
}

/** Raw source text for a token that can take part in a path word. */
function wordText(token) {
  if (token.type === TOKEN.NUMBER) return token.raw === undefined ? String(token.value) : token.raw;
  return String(token.raw === undefined ? token.value : token.raw);
}

/** Tokens allowed inside a path word. Strings are handled separately. */
function isPathToken(token) {
  if (token.type === TOKEN.IDENT || token.type === TOKEN.NUMBER) return true;
  if (token.type === TOKEN.OP && token.value === '/') return true;
  return token.type === TOKEN.PUNCT && token.value === '.';
}

/** True when the two tokens touch in the source (no whitespace between). */
function adjacentTokens(left, right) {
  return Boolean(left && right && left.line === right.line
    && left.column + wordText(left).length === right.column);
}

/**
 * The lexer sees `-la` as three tokens (`-`, `l`, `a`) because `-` is also a
 * binary operator. In command position, however, those tokens form a single
 * flag word. Rejoin consecutive dashes and short flag names here, and also
 * extend an existing flag (`--abbrev` + `-ref` -> `--abbrev-ref`).
 */
function normalizeFlagWords(words) {
  const text = (word) => {
    if (word.name !== undefined) return word.name;
    return String(word.raw === undefined ? word.value : word.raw);
  };
  const adjacent = (left, right) => (
    left && right && left.line === right.line && left.column + text(left).length === right.column
  );

  const result = [];
  let i = 0;
  while (i < words.length) {
    const word = words[i];
    if (word.type === 'Literal' && word.value === '-') {
      let dashes = '-';
      let cursor = i + 1;
      while (
        cursor < words.length && words[cursor].type === 'Literal' && words[cursor].value === '-'
        && adjacent(words[cursor - 1], words[cursor])
      ) {
        dashes += '-';
        cursor += 1;
      }
      const next = words[cursor];
      const previous = result[result.length - 1];
      const joined = `${dashes}${next && next.name ? next.name : ''}`;
      const nextAdjacent = next && word.line === next.line && word.column + dashes.length === next.column;
      const previousAdjacent = adjacent(previous, word);
      const previousIsFlag = previous && previous.type === 'Literal' && text(previous).startsWith('-');

      if (next && next.type === 'Variable' && next.bare) {
        if (nextAdjacent) {
          // `rev-parse`, `foo-bar`, `--long-flag`: no spaces in the source.
          if (previousAdjacent) {
            const merged = text(previous) + joined;
            previous.type = 'Literal';
            previous.value = merged;
            previous.raw = merged;
            delete previous.name;
            delete previous.bare;
          } else {
            result.push(node('Literal', word, { value: joined, raw: joined }));
          }
          i = cursor + 1;
          continue;
        }
        if (dashes === '--' || next.name.length === 1 || previousIsFlag) {
          // `-p dir`, `--flag`, `--long-flag`: a separated flag word.
          if (previousIsFlag) {
            previous.value += joined;
            previous.raw += joined;
          } else {
            result.push(node('Literal', word, { value: joined, raw: joined }));
          }
          i = cursor + 1;
          continue;
        }
      }
    }
    result.push(word);
    i += 1;
  }
  return result;
}

/** Build an AST node with source position. */
function node(type, token, fields) {
  return { type, line: token.line, column: token.column, ...fields };
}

function describeToken(token) {
  if (token.type === TOKEN.EOF) return 'end of input';
  if (token.type === TOKEN.NEWLINE) return 'end of line';
  if (token.type === TOKEN.STRING) return `string ${JSON.stringify(token.value)}`;
  return JSON.stringify(String(token.value));
}

/** Parse source text into a Program AST. */
function parse(source) {
  if (typeof source !== 'string') throw new TypeError('parse expects a string');
  return new Parser(tokenize(source)).parseProgram();
}

/** Parse an already-tokenized input (useful for embedding/interpolation). */
function parseTokens(tokens) {
  return new Parser(tokens).parseProgram();
}

/** Parse a single expression source string (used for `${...}` interpolation). */
function parseExpression(source) {
  const tokens = tokenize(source);
  const parser = new Parser(tokens);
  parser.skipNewlines();
  const expression = parser.parseExpression();
  parser.skipNewlines();
  if (!parser.at(TOKEN.EOF)) {
    parser.error(`Unexpected token ${describeToken(parser.peek())} in expression`);
  }
  return expression;
}

module.exports = { Parser, ParserError, parse, parseTokens, parseExpression };
