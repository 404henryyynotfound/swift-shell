'use strict';

/**
 * SwiftShell lexer.
 *
 * Produces a flat list of tokens. Each token carries its source position so
 * both parse errors and runtime errors can point at an exact line/column.
 * Newlines are significant (they terminate statements) but the parser is
 * responsible for ignoring them where the grammar allows it.
 *
 * Double quoted strings keep their *structure*: instead of being flattened to
 * text, they carry a `parts` array with literal text, `$name` variable markers
 * and `${expr}` expression markers. The expression markers hold the raw source
 * text, which the interpreter lexes/parses on demand. That keeps the lexer
 * independent of the parser while still supporting full expression
 * interpolation (including nested quotes and braces).
 */

/** Token kinds emitted by the lexer. */
const TOKEN = Object.freeze({
  IDENT: 'IDENT',
  NUMBER: 'NUMBER',
  STRING: 'STRING',
  OP: 'OP',
  PUNCT: 'PUNCT',
  NEWLINE: 'NEWLINE',
  EOF: 'EOF',
});

/** Multi-character operators/punctuation, longest first. */
const DOUBLE_TOKENS = new Map([
  ['==', { type: TOKEN.OP }],
  ['!=', { type: TOKEN.OP }],
  ['>=', { type: TOKEN.OP }],
  ['<=', { type: TOKEN.OP }],
  ['&&', { type: TOKEN.OP }],
  ['>>', { type: TOKEN.PUNCT }], // append redirection
  ['$(', { type: TOKEN.PUNCT }], // command substitution opener
]);

const SINGLE_TOKENS = new Map([
  ['=', { type: TOKEN.OP }],
  ['!', { type: TOKEN.OP }],
  ['>', { type: TOKEN.OP }], // comparison here, redirection decided by parser
  ['<', { type: TOKEN.OP }],
  ['+', { type: TOKEN.OP }],
  ['-', { type: TOKEN.OP }],
  ['*', { type: TOKEN.OP }],
  ['/', { type: TOKEN.OP }],
  ['%', { type: TOKEN.OP }],
  ['{', { type: TOKEN.PUNCT }],
  ['}', { type: TOKEN.PUNCT }],
  ['(', { type: TOKEN.PUNCT }],
  [')', { type: TOKEN.PUNCT }],
  ['[', { type: TOKEN.PUNCT }],
  [']', { type: TOKEN.PUNCT }],
  [',', { type: TOKEN.PUNCT }],
  ['.', { type: TOKEN.PUNCT }], // method sugar: "text".upper()
  [';', { type: TOKEN.PUNCT }],
  ['|', { type: TOKEN.PUNCT }],
]);

const isDigit = (ch) => ch >= '0' && ch <= '9';
const isIdentStart = (ch) => /[A-Za-z_]/.test(ch);
const isIdentPart = (ch) => /[A-Za-z0-9_]/.test(ch);

/** Error thrown for malformed source. Extends the native SyntaxError. */
class LexerError extends SyntaxError {
  constructor(message, line, column) {
    super(`${message} (line ${line}, column ${column})`);
    this.name = 'SyntaxError';
    this.line = line;
    this.column = column;
  }
}

/**
 * Tokenize SwiftShell source code.
 *
 * @param {string} source
 * @returns {Array<object>} tokens, always terminated by an EOF token
 */
function tokenize(source) {
  if (typeof source !== 'string') {
    throw new TypeError('tokenize expects a string');
  }

  const tokens = [];
  const length = source.length;
  let i = 0;
  let line = 1;
  let column = 1;

  const push = (type, value, startLine, startColumn, extra = {}) => {
    tokens.push({ type, value, line: startLine, column: startColumn, ...extra });
  };

  const fail = (message, atLine = line, atColumn = column) => {
    throw new LexerError(message, atLine, atColumn);
  };

  /** Consume one character and advance the position counters. */
  const advance = () => {
    const ch = source[i++];
    if (ch === '\n') {
      line += 1;
      column = 1;
    } else {
      column += 1;
    }
    return ch;
  };

  /**
   * Read a quoted string. `startLine`/`startColumn` point at the opening
   * quote. Literal strings ('...') never produce interpolation markers.
   */
  const readString = (quote, startLine, startColumn) => {
    advance(); // opening quote
    const parts = [];
    let text = '';
    let closed = false;

    const flushText = () => {
      if (text.length > 0) {
        parts.push({ type: 'text', value: text });
        text = '';
      }
    };

    while (i < length) {
      const ch = source[i];

      if (ch === quote) {
        advance();
        closed = true;
        break;
      }
      if (ch === '\n') {
        fail('Unterminated string literal', startLine, startColumn);
      }

      if (ch === '\\') {
        const escapeLine = line;
        const escapeColumn = column;
        advance(); // backslash
        if (i >= length) fail('Unterminated escape sequence', escapeLine, escapeColumn);
        const escaped = advance();
        // Both quote styles accept backslash escapes for themselves and for
        // backslash. Double quotes additionally support the usual control
        // escapes; single quotes are otherwise strictly literal.
        if (escaped === 'n' && quote === '"') text += '\n';
        else if (escaped === 't' && quote === '"') text += '\t';
        else if (escaped === 'r' && quote === '"') text += '\r';
        else if (escaped === '0' && quote === '"') text += '\0';
        else if (escaped === '$' && quote === '"') text += '$';
        else text += escaped;
        continue;
      }

      if (quote === '"' && ch === '$') {
        const markerLine = line;
        const markerColumn = column;
        advance(); // '$'

        if (i < length && source[i] === '{') {
          advance(); // '{'
          // Scan to the matching '}' with depth tracking. Quoted sections
          // inside the expression are skipped so braces in strings do not
          // disturb the depth count.
          let depth = 1;
          let expr = '';
          let exprLine = line;
          let exprColumn = column;
          let exprClosed = false;
          while (i < length) {
            const c = source[i];
            if (c === '\n') {
              expr += c;
              advance();
              continue;
            }
            if (c === "'" || c === '"') {
              const innerQuote = c;
              expr += c;
              advance();
              while (i < length && source[i] !== innerQuote) {
                if (source[i] === '\\' && i + 1 < length) {
                  expr += source[i] + source[i + 1];
                  advance();
                }
                expr += source[i];
                advance();
              }
              if (i < length) {
                expr += innerQuote;
                advance();
              }
              continue;
            }
            if (c === '{') depth += 1;
            if (c === '}') {
              depth -= 1;
              if (depth === 0) {
                advance();
                exprClosed = true;
                break;
              }
            }
            expr += c;
            advance();
          }
          if (!exprClosed) fail('Unterminated ${...} interpolation', markerLine, markerColumn);
          flushText();
          parts.push({
            type: 'expr',
            source: expr,
            line: exprLine,
            column: exprColumn,
          });
          continue;
        }

        if (i < length && isIdentStart(source[i])) {
          let name = '';
          while (i < length && isIdentPart(source[i])) name += advance();
          flushText();
          parts.push({ type: 'var', name, line: markerLine, column: markerColumn });
          continue;
        }

        // A '$' that is not an interpolation marker is just a dollar sign.
        text += '$';
        continue;
      }

      text += advance();
    }

    if (!closed) fail('Unterminated string literal', startLine, startColumn);
    flushText();
    if (parts.length === 0) parts.push({ type: 'text', value: '' });

    // `value` is the static rendering of the string (interpolations removed);
    // `parts` is the authoritative representation used by the interpreter.
    const staticValue = parts
      .filter((part) => part.type === 'text')
      .map((part) => part.value)
      .join('');
    push(TOKEN.STRING, staticValue, startLine, startColumn, { parts, rawQuote: quote });
  };

  while (i < length) {
    const ch = source[i];
    const startLine = line;
    const startColumn = column;

    // Whitespace (newlines are tokens, so handle them separately).
    if (ch === ' ' || ch === '\t' || ch === '\r') {
      advance();
      continue;
    }
    if (ch === '\n') {
      advance();
      push(TOKEN.NEWLINE, '\n', startLine, startColumn);
      continue;
    }

    // Comments: '#' to the end of the line.
    if (ch === '#') {
      while (i < length && source[i] !== '\n') advance();
      continue;
    }

    // Quoted strings.
    if (ch === '"' || ch === "'") {
      readString(ch, startLine, startColumn);
      continue;
    }

    // Identifiers / keywords (keywords are recognised by the parser).
    if (isIdentStart(ch)) {
      let value = '';
      while (i < length && isIdentPart(source[i])) value += advance();
      push(TOKEN.IDENT, value, startLine, startColumn);
      continue;
    }

    // Numbers: integer, fractional and exponent forms. A leading '.' is
    // allowed only when followed by a digit.
    if (isDigit(ch) || (ch === '.' && i + 1 < length && isDigit(source[i + 1]))) {
      let raw = '';
      let kind = 'int';
      while (i < length && isDigit(source[i])) raw += advance();
      if (i < length && source[i] === '.' && i + 1 < length && isDigit(source[i + 1])) {
        kind = 'float';
        raw += advance(); // '.'
        while (i < length && isDigit(source[i])) raw += advance();
      }
      if (i < length && (source[i] === 'e' || source[i] === 'E')) {
        kind = 'float';
        raw += advance(); // e/E
        if (i < length && (source[i] === '+' || source[i] === '-')) raw += advance();
        if (i >= length || !isDigit(source[i])) {
          fail('Malformed exponent in numeric literal', startLine, startColumn);
        }
        while (i < length && isDigit(source[i])) raw += advance();
      }
      push(TOKEN.NUMBER, Number(raw), startLine, startColumn, { raw, kind });
      continue;
    }

    // Two-character operators/punctuation.
    const pair = source.slice(i, i + 2);
    if (DOUBLE_TOKENS.has(pair)) {
      const spec = DOUBLE_TOKENS.get(pair);
      advance();
      advance();
      push(spec.type, pair, startLine, startColumn);
      continue;
    }

    // Single-character operators/punctuation.
    if (SINGLE_TOKENS.has(ch)) {
      const spec = SINGLE_TOKENS.get(ch);
      advance();
      push(spec.type, ch, startLine, startColumn);
      continue;
    }

    fail(`Unexpected character ${JSON.stringify(ch)}`, startLine, startColumn);
  }

  push(TOKEN.EOF, '<eof>', line, column);
  return tokens;
}

module.exports = { tokenize, TOKEN, LexerError };
