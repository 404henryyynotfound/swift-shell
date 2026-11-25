/*
 * SwiftShell site interactions + a tiny, safe in-browser playground.
 *
 * The playground implements a deliberately small subset of SwiftShell:
 *   let, echo, + - * / %, unary -, upper/lower/len/range,
 *   for ... in range(...), if / else, comparisons and # comments.
 *
 * It is a hand-written tokenizer / parser / evaluator. It never uses
 * eval(), new Function(), the network, or any dependency.
 */
(function () {
  'use strict';

  /* =========================================================
     1. Playground language implementation
     ========================================================= */

  class ShellError extends Error {
    constructor(message, line) {
      const where = line ? ' (line ' + line + ')' : '';
      super(message + where);
      this.name = 'ShellError';
      this.line = line || 1;
    }
  }

  const WORD_START = /[A-Za-z_]/;
  const WORD_PART = /[A-Za-z0-9_]/;
  const NUMBER_PART = /[0-9.]/;
  const TWO_CHAR_SYMBOLS = ['==', '!=', '<=', '>='];
  const ONE_CHAR_SYMBOLS = '+-*/%(){}<>,;=!';

  /** Turn source text into a flat list of tokens. */
  function tokenize(source) {
    const tokens = [];
    const length = source.length;
    let i = 0;
    let line = 1;

    while (i < length) {
      const ch = source[i];

      if (ch === '\n') {
        line += 1;
        i += 1;
        continue;
      }
      if (/\s/.test(ch)) {
        i += 1;
        continue;
      }
      if (ch === '#') {
        while (i < length && source[i] !== '\n') i += 1;
        continue;
      }

      if (ch === '"') {
        i += 1;
        let value = '';
        let closed = false;
        while (i < length) {
          const current = source[i];
          if (current === '"') {
            closed = true;
            i += 1;
            break;
          }
          if (current === '\\') {
            const next = source[i + 1];
            if (next === 'n') value += '\n';
            else if (next === 't') value += '\t';
            else if (next === 'r') value += '\r';
            else if (next === '"') value += '"';
            else if (next === '\\') value += '\\';
            else if (typeof next === 'string') value += next;
            i += 2;
            continue;
          }
          value += current;
          i += 1;
        }
        if (!closed) throw new ShellError('Unterminated string', line);
        tokens.push({ type: 'str', value: value, line: line });
        continue;
      }

      if (NUMBER_PART.test(ch)) {
        let raw = '';
        while (i < length && NUMBER_PART.test(source[i])) {
          raw += source[i];
          i += 1;
        }
        const value = Number(raw);
        if (!Number.isFinite(value)) throw new ShellError('Invalid number "' + raw + '"', line);
        tokens.push({ type: 'num', value: value, line: line });
        continue;
      }

      if (WORD_START.test(ch)) {
        let raw = '';
        while (i < length && WORD_PART.test(source[i])) {
          raw += source[i];
          i += 1;
        }
        tokens.push({ type: 'word', value: raw, line: line });
        continue;
      }

      const pair = source.slice(i, i + 2);
      if (TWO_CHAR_SYMBOLS.indexOf(pair) !== -1) {
        tokens.push({ type: 'sym', value: pair, line: line });
        i += 2;
        continue;
      }
      if (ONE_CHAR_SYMBOLS.indexOf(ch) !== -1) {
        tokens.push({ type: 'sym', value: ch, line: line });
        i += 1;
        continue;
      }

      throw new ShellError('Unexpected character "' + ch + '"', line);
    }

    tokens.push({ type: 'eof', value: '', line: line });
    return tokens;
  }

  const STATEMENT_WORDS = ['let', 'echo', 'for', 'if', 'else'];

  /** Recursive-descent parser: tokens -> AST. */
  class Parser {
    constructor(tokens) {
      this.tokens = tokens;
      this.pos = 0;
    }

    peek() { return this.tokens[this.pos]; }
    advance() { return this.tokens[this.pos++]; }
    atEnd() { return this.peek().type === 'eof'; }

    checkSym(value) {
      const token = this.peek();
      return token.type === 'sym' && token.value === value;
    }
    matchSym(value) {
      if (!this.checkSym(value)) return false;
      this.advance();
      return true;
    }
    expectSym(value) {
      if (!this.checkSym(value)) this.error("Expected '" + value + "'");
      return this.advance();
    }
    checkWord(value) {
      const token = this.peek();
      return token.type === 'word' && token.value === value;
    }
    matchWord(value) {
      if (!this.checkWord(value)) return false;
      this.advance();
      return true;
    }
    expectWord(value) {
      if (!this.checkWord(value)) this.error("Expected '" + value + "'");
      return this.advance();
    }
    expectName(description) {
      const token = this.peek();
      const reserved = STATEMENT_WORDS.concat(['in', 'true', 'false']);
      if (token.type !== 'word' || reserved.indexOf(token.value) !== -1) {
        this.error('Expected ' + description);
      }
      return this.advance();
    }
    error(message) {
      const token = this.peek();
      const got = token.type === 'eof' ? 'end of input' : "'" + token.value + "'";
      throw new ShellError(message + ' — got ' + got, token.line);
    }

    skipSemicolons() {
      while (this.matchSym(';')) { /* optional separators */ }
    }

    isBoundary() {
      const token = this.peek();
      if (token.type === 'eof') return true;
      if (token.type === 'sym') return token.value === '}' || token.value === ';';
      if (token.type === 'word') return STATEMENT_WORDS.indexOf(token.value) !== -1;
      return false;
    }

    parseProgram() {
      const body = [];
      this.skipSemicolons();
      while (!this.atEnd()) {
        if (this.checkSym('}')) this.error("Unexpected '}'");
        body.push(this.parseStatement());
        this.skipSemicolons();
      }
      return { type: 'Program', body: body };
    }

    parseStatement() {
      if (this.checkWord('let')) return this.parseLet();
      if (this.checkWord('echo')) return this.parseEcho();
      if (this.checkWord('for')) return this.parseFor();
      if (this.checkWord('if')) return this.parseIf();
      this.error('Expected a statement (let, echo, for, or if)');
      return null;
    }

    parseLet() {
      const token = this.advance();
      const name = this.expectName('a variable name after let');
      this.expectSym('=');
      const expr = this.parseExpression();
      return { type: 'Let', name: name.value, expr: expr, line: token.line };
    }

    parseEcho() {
      const token = this.advance();
      const args = [];
      if (!this.isBoundary()) {
        args.push(this.parseExpression());
        while (this.matchSym(',')) args.push(this.parseExpression());
      }
      return { type: 'Echo', args: args, line: token.line };
    }

    parseFor() {
      const token = this.advance();
      const name = this.expectName('a loop variable after for');
      this.expectWord('in');
      const iterable = this.parseExpression();
      const body = this.parseBlock();
      return {
        type: 'For',
        name: name.value,
        iterable: iterable,
        body: body,
        line: token.line
      };
    }

    parseIf() {
      const token = this.advance();
      const cond = this.parseExpression();
      const consequent = this.parseBlock();
      let alternate = null;
      if (this.matchWord('else')) {
        alternate = this.checkWord('if') ? this.parseIf() : this.parseBlock();
      }
      return {
        type: 'If',
        cond: cond,
        consequent: consequent,
        alternate: alternate,
        line: token.line
      };
    }

    parseBlock() {
      const open = this.expectSym('{');
      const body = [];
      this.skipSemicolons();
      while (!this.checkSym('}') && !this.atEnd()) {
        body.push(this.parseStatement());
        this.skipSemicolons();
      }
      this.expectSym('}');
      return { type: 'Block', body: body, line: open.line };
    }

    parseExpression() { return this.parseEquality(); }

    parseEquality() {
      let left = this.parseComparison();
      while (this.checkSym('==') || this.checkSym('!=')) {
        const op = this.advance();
        const right = this.parseComparison();
        left = { type: 'Binary', op: op.value, left: left, right: right, line: op.line };
      }
      return left;
    }

    parseComparison() {
      let left = this.parseTerm();
      while (this.checkSym('<') || this.checkSym('<=') || this.checkSym('>') || this.checkSym('>=')) {
        const op = this.advance();
        const right = this.parseTerm();
        left = { type: 'Binary', op: op.value, left: left, right: right, line: op.line };
      }
      return left;
    }

    parseTerm() {
      let left = this.parseFactor();
      while (this.checkSym('+') || this.checkSym('-')) {
        const op = this.advance();
        const right = this.parseFactor();
        left = { type: 'Binary', op: op.value, left: left, right: right, line: op.line };
      }
      return left;
    }

    parseFactor() {
      let left = this.parseUnary();
      while (this.checkSym('*') || this.checkSym('/') || this.checkSym('%')) {
        const op = this.advance();
        const right = this.parseUnary();
        left = { type: 'Binary', op: op.value, left: left, right: right, line: op.line };
      }
      return left;
    }

    parseUnary() {
      if (this.checkSym('-') || this.checkSym('!')) {
        const op = this.advance();
        const arg = this.parseUnary();
        return { type: 'Unary', op: op.value, arg: arg, line: op.line };
      }
      return this.parsePrimary();
    }

    parsePrimary() {
      const token = this.peek();

      if (token.type === 'num') {
        this.advance();
        return { type: 'Number', value: token.value, line: token.line };
      }
      if (token.type === 'str') {
        this.advance();
        return { type: 'String', value: token.value, line: token.line };
      }
      if (token.type === 'word') {
        if (token.value === 'true' || token.value === 'false') {
          this.advance();
          return { type: 'Boolean', value: token.value === 'true', line: token.line };
        }
        if (STATEMENT_WORDS.indexOf(token.value) !== -1) {
          this.error("Unexpected keyword '" + token.value + "' in expression");
        }
        this.advance();
        if (this.checkSym('(')) {
          this.advance();
          const args = [];
          if (!this.checkSym(')')) {
            args.push(this.parseExpression());
            while (this.matchSym(',')) args.push(this.parseExpression());
          }
          this.expectSym(')');
          return { type: 'Call', name: token.value, args: args, line: token.line };
        }
        return { type: 'Identifier', name: token.value, line: token.line };
      }
      if (this.checkSym('(')) {
        this.advance();
        const inner = this.parseExpression();
        this.expectSym(')');
        return inner;
      }

      this.error('Expected a value');
      return null;
    }
  }

  /** Simple lexically scoped environment. */
  class Env {
    constructor(parent) {
      this.parent = parent || null;
      this.values = new Map();
    }
    declare(name, value) {
      this.values.set(name, value);
    }
    get(name, line) {
      if (this.values.has(name)) return this.values.get(name);
      if (this.parent) return this.parent.get(name, line);
      throw new ShellError("Undefined variable '" + name + "'", line);
    }
  }

  function formatValue(value) {
    if (typeof value === 'string') return value;
    if (typeof value === 'boolean') return value ? 'true' : 'false';
    if (typeof value === 'number') {
      if (Number.isInteger(value)) return String(value);
      return String(Number(value.toFixed(6)));
    }
    if (Array.isArray(value)) return '[' + value.map(formatValue).join(', ') + ']';
    if (value === null || value === undefined) return 'null';
    return String(value);
  }

  function truthy(value) {
    if (value === false || value === 0 || value === '' || value === null || value === undefined) return false;
    return Boolean(value);
  }

  function tick(ctx, line) {
    ctx.steps += 1;
    if (ctx.steps > ctx.maxSteps) {
      throw new ShellError('Execution limit reached — check for a runaway loop', line);
    }
  }

  function requireNumber(value, op, line) {
    if (typeof value !== 'number') {
      throw new ShellError("Operator '" + op + "' needs numbers on both sides", line);
    }
  }

  function applyBinary(op, left, right, line) {
    switch (op) {
      case '+':
        if (typeof left === 'number' && typeof right === 'number') return left + right;
        return formatValue(left) + formatValue(right);
      case '-':
      case '*':
      case '/':
      case '%':
        requireNumber(left, op, line);
        requireNumber(right, op, line);
        if ((op === '/' || op === '%') && right === 0) throw new ShellError('Division by zero', line);
        if (op === '-') return left - right;
        if (op === '*') return left * right;
        if (op === '/') return left / right;
        return left % right;
      case '==':
        if (typeof left === 'number' && typeof right === 'number') return left === right;
        return formatValue(left) === formatValue(right);
      case '!=':
        if (typeof left === 'number' && typeof right === 'number') return left !== right;
        return formatValue(left) !== formatValue(right);
      case '<':
      case '<=':
      case '>':
      case '>=': {
        let a = left;
        let b = right;
        if (typeof a !== 'number' || typeof b !== 'number') {
          a = formatValue(a);
          b = formatValue(b);
        }
        if (op === '<') return a < b;
        if (op === '<=') return a <= b;
        if (op === '>') return a > b;
        return a >= b;
      }
      default:
        throw new ShellError("Unknown operator '" + op + "'", line);
    }
  }

  function oneStringArg(args, name, line) {
    if (args.length !== 1) throw new ShellError(name + '() expects exactly one argument', line);
    return formatValue(args[0]);
  }

  function callBuiltin(name, args, line, ctx) {
    switch (name) {
      case 'range': {
        let start;
        let end;
        if (args.length === 1) {
          start = 0;
          end = args[0];
        } else if (args.length === 2) {
          start = args[0];
          end = args[1];
        } else {
          throw new ShellError('range() expects 1 or 2 numbers', line);
        }
        if (typeof start !== 'number' || typeof end !== 'number') {
          throw new ShellError('range() expects numeric arguments', line);
        }
        const first = Math.floor(start);
        const last = Math.floor(end);
        if (last - first > ctx.maxIterations) {
          throw new ShellError('range() is too large for the playground', line);
        }
        const result = [];
        for (let n = first; n < last; n += 1) result.push(n);
        return result;
      }
      case 'upper':
        return oneStringArg(args, 'upper', line).toUpperCase();
      case 'lower':
        return oneStringArg(args, 'lower', line).toLowerCase();
      case 'len': {
        if (args.length !== 1) throw new ShellError('len() expects exactly one argument', line);
        const value = args[0];
        if (typeof value === 'string' || Array.isArray(value)) return value.length;
        throw new ShellError('len() expects a string or array', line);
      }
      default:
        throw new ShellError("Unknown function '" + name + "'", line);
    }
  }

  function evalExpr(node, env, ctx) {
    tick(ctx, node.line);
    switch (node.type) {
      case 'Number':
      case 'String':
      case 'Boolean':
        return node.value;
      case 'Identifier':
        return env.get(node.name, node.line);
      case 'Unary': {
        const value = evalExpr(node.arg, env, ctx);
        if (node.op === '-') {
          requireNumber(value, 'unary -', node.line);
          return -value;
        }
        return !truthy(value);
      }
      case 'Binary': {
        const left = evalExpr(node.left, env, ctx);
        const right = evalExpr(node.right, env, ctx);
        return applyBinary(node.op, left, right, node.line);
      }
      case 'Call': {
        const args = node.args.map(function (arg) { return evalExpr(arg, env, ctx); });
        return callBuiltin(node.name, args, node.line, ctx);
      }
      default:
        throw new ShellError('Cannot evaluate node: ' + node.type, node.line);
    }
  }

  function execStatement(node, env, ctx) {
    tick(ctx, node.line);
    switch (node.type) {
      case 'Block': {
        const scope = new Env(env);
        for (const statement of node.body) execStatement(statement, scope, ctx);
        return;
      }
      case 'Let': {
        const value = evalExpr(node.expr, env, ctx);
        env.declare(node.name, value);
        return;
      }
      case 'Echo': {
        const values = node.args.map(function (arg) { return evalExpr(arg, env, ctx); });
        ctx.output.push(values.map(formatValue).join(' '));
        if (ctx.output.length > ctx.maxLines) {
          throw new ShellError('Too much output for the playground', node.line);
        }
        return;
      }
      case 'For': {
        const iterable = evalExpr(node.iterable, env, ctx);
        if (!Array.isArray(iterable)) {
          throw new ShellError('for ... in expects an array (try range())', node.line);
        }
        if (iterable.length > ctx.maxIterations) {
          throw new ShellError('Too many iterations for the playground', node.line);
        }
        for (const value of iterable) {
          tick(ctx, node.line);
          const scope = new Env(env);
          scope.declare(node.name, value);
          execStatement(node.body, scope, ctx);
        }
        return;
      }
      case 'If': {
        const condition = evalExpr(node.cond, env, ctx);
        if (truthy(condition)) execStatement(node.consequent, env, ctx);
        else if (node.alternate) execStatement(node.alternate, env, ctx);
        return;
      }
      default:
        throw new ShellError('Unknown statement: ' + node.type, node.line);
    }
  }

  /** Run source text and return everything the program printed. */
  function runProgram(source) {
    const ctx = {
      steps: 0,
      output: [],
      maxSteps: 5000,
      maxIterations: 500,
      maxLines: 200
    };
    try {
      const tokens = tokenize(source);
      const program = new Parser(tokens).parseProgram();
      const env = new Env(null);
      for (const statement of program.body) execStatement(statement, env, ctx);
      return ctx.output.length ? ctx.output.join('\n') : '(no output)';
    } catch (error) {
      const prefix = ctx.output.length ? ctx.output.join('\n') + '\n' : '';
      const message = error && error.message ? error.message : String(error);
      return prefix + 'Error: ' + message;
    }
  }

  /* =========================================================
     2. Page interactions
     ========================================================= */

  function initNav() {
    const toggle = document.querySelector('[data-nav-toggle]');
    const nav = document.querySelector('[data-nav]');
    if (!toggle || !nav) return;

    function close() {
      nav.classList.remove('is-open');
      toggle.setAttribute('aria-expanded', 'false');
      toggle.setAttribute('aria-label', 'Open navigation');
    }

    toggle.addEventListener('click', function () {
      const open = !nav.classList.contains('is-open');
      nav.classList.toggle('is-open', open);
      toggle.setAttribute('aria-expanded', String(open));
      toggle.setAttribute('aria-label', open ? 'Close navigation' : 'Open navigation');
    });

    nav.querySelectorAll('a').forEach(function (link) {
      link.addEventListener('click', close);
    });
    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape') close();
    });
  }

  function fallbackCopy(text) {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.top = '-1000px';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    let copied = false;
    try {
      copied = document.execCommand('copy');
    } catch (error) {
      copied = false;
    }
    document.body.removeChild(area);
    if (!copied) throw new Error('Clipboard unavailable');
  }

  async function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch (error) {
        /* fall through to the local fallback */
      }
    }
    try {
      fallbackCopy(text);
      return true;
    } catch (error) {
      return false;
    }
  }

  function initCopyButtons() {
    document.querySelectorAll('[data-copy]').forEach(function (button) {
      const selector = button.getAttribute('data-copy');
      const target = selector ? document.querySelector(selector) : null;
      if (!target) return;
      const original = button.textContent.trim();
      let timer = null;

      button.addEventListener('click', async function () {
        const ok = await copyText(target.textContent.trim());
        button.textContent = ok ? 'Copied!' : 'Select text';
        button.classList.toggle('is-copied', ok);
        if (timer) clearTimeout(timer);
        timer = setTimeout(function () {
          button.textContent = original;
          button.classList.remove('is-copied');
          timer = null;
        }, 1800);
      });
    });
  }

  function initReveal() {
    const elements = document.querySelectorAll('.reveal');
    if (!elements.length) return;
    if (!('IntersectionObserver' in window)) {
      elements.forEach(function (element) { element.classList.add('is-visible'); });
      return;
    }
    const observer = new IntersectionObserver(function (entries, obs) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        entry.target.classList.add('is-visible');
        obs.unobserve(entry.target);
      });
    }, { threshold: 0.12, rootMargin: '0px 0px -40px 0px' });
    elements.forEach(function (element) { observer.observe(element); });
  }

  function initTabs() {
    document.querySelectorAll('[role="tablist"]').forEach(function (list) {
      const container = list.closest('.tour-content');
      if (!container) return;
      const tabs = Array.prototype.slice.call(list.querySelectorAll('[role="tab"]'));
      const panels = Array.prototype.slice.call(container.querySelectorAll('[role="tabpanel"]'));
      if (!tabs.length || !panels.length) return;

      function activate(tab, moveFocus) {
        tabs.forEach(function (item) {
          const active = item === tab;
          item.setAttribute('aria-selected', String(active));
          item.tabIndex = active ? 0 : -1;
        });
        panels.forEach(function (panel) {
          panel.hidden = panel.id !== tab.getAttribute('aria-controls');
        });
        if (moveFocus) tab.focus();
      }

      tabs.forEach(function (tab, index) {
        tab.addEventListener('click', function () { activate(tab, false); });
        tab.addEventListener('keydown', function (event) {
          let next = null;
          if (event.key === 'ArrowRight') next = tabs[(index + 1) % tabs.length];
          else if (event.key === 'ArrowLeft') next = tabs[(index - 1 + tabs.length) % tabs.length];
          else if (event.key === 'Home') next = tabs[0];
          else if (event.key === 'End') next = tabs[tabs.length - 1];
          if (next) {
            event.preventDefault();
            activate(next, true);
          }
        });
      });

      const initial = tabs.filter(function (tab) {
        return tab.getAttribute('aria-selected') === 'true';
      })[0] || tabs[0];
      activate(initial, false);
    });
  }

  function initPlayground() {
    const input = document.getElementById('code-input');
    const output = document.getElementById('playground-output');
    const runButton = document.getElementById('run-code');
    const resetButton = document.getElementById('reset-code');
    if (!input || !output || !runButton || !resetButton) return;

    const original = input.value;
    const examples = {
      hello: [
        'let who = "world"',
        'echo "Hello, " + upper(who)',
        'echo "length: " + len(who)'
      ].join('\n'),
      math: [
        'let a = 12',
        'let b = 5',
        'echo "sum: " + (a + b)',
        'echo "mod: " + (a % b)',
        'echo "div: " + (a / b)'
      ].join('\n'),
      loop: [
        'for i in range(1, 6) {',
        '  if i == 3 {',
        '    echo "three!"',
        '  } else {',
        '    echo "i = " + i',
        '  }',
        '}'
      ].join('\n')
    };

    function run() {
      output.textContent = runProgram(input.value);
    }

    runButton.addEventListener('click', run);
    resetButton.addEventListener('click', function () {
      input.value = original;
      output.textContent = 'Ready. Edit the code and press Run.';
      input.focus();
    });
    input.addEventListener('keydown', function (event) {
      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
        event.preventDefault();
        run();
      }
    });
    document.querySelectorAll('[data-example]').forEach(function (button) {
      button.addEventListener('click', function () {
        const code = examples[button.getAttribute('data-example')];
        if (!code) return;
        input.value = code;
        run();
        input.focus();
      });
    });
  }

  function init() {
    initNav();
    initCopyButtons();
    initReveal();
    initTabs();
    initPlayground();
  }

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', init);
    } else {
      init();
    }
  }

  /* Expose the interpreter for local testing only; harmless in a browser. */
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { ShellError: ShellError, tokenize: tokenize, Parser: Parser, runProgram: runProgram, formatValue: formatValue };
  }
})();
