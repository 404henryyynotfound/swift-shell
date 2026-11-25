'use strict';

/**
 * SwiftShell builtins.
 *
 * Every builtin has the signature `(ctx, args) => value`:
 *
 *   ctx.asCommand   true when invoked as `name arg...`, false for `name(...)`
 *   ctx.out/err     functions that write to the current stdout/stderr sink
 *                   (a capture buffer when inside a pipeline or substitution)
 *   ctx.stdin       string received from the previous pipeline stage
 *   ctx.env         current lexical Environment (for `set`)
 *   ctx.cwd         mutable `{ value }` holding the logical working directory
 *   ctx.line/ctx.column  call-site position for error messages
 *   ctx.invokeCommand   run raw command words through the interpreter
 *
 * Builtins are designed to work in both modes where it makes sense:
 * `pwd()` returns a string while `pwd` prints it; `ls(...)` returns an array
 * while `ls` prints one path per line. `echo` and `printf` always write output
 * because emitting output is their whole purpose.
 */

const fs = require('node:fs');
const path = require('node:path');

const { PackageManager, PackageError } = require('./packages');

const VERSION = '1.0.0';

/** Thrown by the `exit` builtin; the CLI turns it into a process exit code. */
class ExitRequest extends Error {
  constructor(code = 0) {
    super(`exit ${code}`);
    this.name = 'ExitRequest';
    this.code = code;
  }
}

/** Errors originating in a builtin; the interpreter adds source coordinates. */
class BuiltinError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'BuiltinError';
    this.line = options.line;
    this.column = options.column;
  }
}

const fail = (message, ctx) => {
  throw new BuiltinError(message, { line: ctx && ctx.line, column: ctx && ctx.column });
};

/** Stringify a SwiftShell value in a predictable, shell-friendly way. */
function toStr(value) {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) return value.map(toStr).join(' ');
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function valuesEqualBuiltin(a, b) {
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, index) => valuesEqualBuiltin(item, b[index]));
  }
  return a === b;
}

function toNumber(value, ctx) {
  if (typeof value === 'number') return value;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value === null || value === undefined) return 0;
  const parsed = Number(String(value).trim());
  if (Number.isNaN(parsed)) fail(`Expected a number, got ${JSON.stringify(toStr(value))}`, ctx);
  return parsed;
}

/** Pipeline stdin normally ends with one newline from `echo`; drop it. */
function stdinText(ctx) {
  return String(ctx.stdin || '').replace(/\n$/, '');
}

function write(ctx, text) {
  ctx.out(String(text));
}

function writeln(ctx, text = '') {
  write(ctx, `${String(text)}\n`);
}

/** Resolve a user-supplied path against the logical working directory. */
function resolvePath(ctx, target) {
  return path.resolve(ctx.cwd.value, toStr(target || '.'));
}

// ---- Safe arithmetic evaluator for `math` ---------------------------------

/**
 * A tiny recursive-descent parser for arithmetic strings. It intentionally
 * shares no code with `eval`/`new Function`: only numbers, parentheses,
 * operators and a fixed set of pure functions are recognised.
 */
class MathParser {
  constructor(source) {
    this.source = source;
    this.index = 0;
  }

  skipSpaces() {
    while (/\s/.test(this.source[this.index] || '')) this.index += 1;
  }

  peek() {
    this.skipSpaces();
    return this.source[this.index] || null;
  }

  match(ch) {
    if (this.peek() === ch) {
      this.index += 1;
      return true;
    }
    return false;
  }

  expect(ch) {
    if (!this.match(ch)) throw new BuiltinError(`math: expected '${ch}' near column ${this.index + 1}`);
  }

  readIdentifier() {
    this.skipSpaces();
    const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(this.source.slice(this.index));
    if (!match) return null;
    this.index += match[0].length;
    return match[0];
  }

  readNumber() {
    this.skipSpaces();
    const match = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/.exec(this.source.slice(this.index));
    if (!match) throw new BuiltinError(`math: expected a number near column ${this.index + 1}`);
    this.index += match[0].length;
    return Number(match[0]);
  }

  parse() {
    const value = this.expression();
    if (this.peek() !== null) {
      throw new BuiltinError(`math: unexpected character '${this.peek()}' near column ${this.index + 1}`);
    }
    return value;
  }

  expression() {
    let value = this.term();
    for (;;) {
      if (this.match('+')) value += this.term();
      else if (this.match('-')) value -= this.term();
      else return value;
    }
  }

  term() {
    let value = this.power();
    for (;;) {
      if (this.match('*')) value *= this.power();
      else if (this.match('/')) {
        const divisor = this.power();
        if (divisor === 0) throw new BuiltinError('math: division by zero');
        value /= divisor;
      } else if (this.match('%')) {
        const divisor = this.power();
        if (divisor === 0) throw new BuiltinError('math: modulo by zero');
        value %= divisor;
      } else return value;
    }
  }

  // Right-associative exponentiation: 2 ^ 3 ^ 2 === 2 ^ (3 ^ 2).
  power() {
    const base = this.unary();
    if (this.match('^')) return base ** this.power();
    return base;
  }

  unary() {
    if (this.match('-')) return -this.unary();
    if (this.match('+')) return this.unary();
    return this.primary();
  }

  primary() {
    if (this.match('(')) {
      const value = this.expression();
      this.expect(')');
      return value;
    }
    const name = this.readIdentifier();
    if (name) {
      if (this.match('(')) {
        const args = [];
        if (!this.match(')')) {
          for (;;) {
            args.push(this.expression());
            if (this.match(',')) continue;
            this.expect(')');
            break;
          }
        }
        return callMathFunction(name, args);
      }
      const lower = name.toLowerCase();
      if (lower === 'pi') return Math.PI;
      if (lower === 'e') return Math.E;
      throw new BuiltinError(`math: unknown name '${name}'`);
    }
    return this.readNumber();
  }
}

const MATH_FUNCTIONS = {
  abs: (x) => Math.abs(x),
  sqrt: (x) => Math.sqrt(x),
  cbrt: (x) => Math.cbrt(x),
  pow: (x, y) => x ** y,
  min: (...xs) => Math.min(...xs),
  max: (...xs) => Math.max(...xs),
  round: (x) => Math.round(x),
  floor: (x) => Math.floor(x),
  ceil: (x) => Math.ceil(x),
  trunc: (x) => Math.trunc(x),
  sin: (x) => Math.sin(x),
  cos: (x) => Math.cos(x),
  tan: (x) => Math.tan(x),
  log: (x) => Math.log(x),
  log10: (x) => Math.log10(x),
  exp: (x) => Math.exp(x),
  sign: (x) => Math.sign(x),
  clamp: (x, low, high) => Math.min(Math.max(x, low), high),
};

function callMathFunction(name, args) {
  const fn = MATH_FUNCTIONS[name.toLowerCase()];
  if (!fn) throw new BuiltinError(`math: unknown function '${name}()'`);
  return fn(...args);
}

/** Public, dependency-free arithmetic evaluator. */
function evaluateMath(source) {
  if (typeof source !== 'string' || source.trim() === '') {
    throw new BuiltinError('math: expected an expression string');
  }
  return new MathParser(source).parse();
}

// Builtin implementations ---------------------------------------------------

function sleepSync(seconds) {
  const ms = Math.max(0, Math.round(seconds * 1000));
  // Atomics.wait blocks without an event loop, which suits this synchronous
  // interpreter. A tiny SharedArrayBuffer is sufficient as the wait subject.
  const buffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
  Atomics.wait(new Int32Array(buffer), 0, 0, ms);
}

/** Convert a glob pattern (with `*` and `?`) to a regular expression. */
function globToRegExp(pattern) {
  let source = '^';
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i];
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        i += 1;
        source += '.*';
      } else {
        source += '[^/]*';
      }
    } else if (ch === '?') {
      source += '[^/]';
    } else {
      source += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`${source}$`);
}

function formatPrintf(format, args) {
  let index = 0;
  let result = '';
  let consumeNext = false;
  for (let i = 0; i < format.length; i += 1) {
    const ch = format[i];
    if (!consumeNext && ch === '\\') {
      const escaped = format[++i];
      result += escaped === 'n' ? '\n' : escaped === 't' ? '\t' : escaped === 'r' ? '\r' : escaped === undefined ? '\\' : escaped;
      continue;
    }
    if (!consumeNext && ch === '%') {
      const spec = format[++i];
      if (spec === '%') {
        result += '%';
        continue;
      }
      const value = args[index++];
      if (spec === 's') result += toStr(value);
      else if (spec === 'd' || spec === 'i') result += String(Math.trunc(toNumber(value)));
      else if (spec === 'f') result += toNumber(value).toFixed(6);
      else if (spec === 'j') result += JSON.stringify(value);
      else if (spec === 'x') result += Math.trunc(toNumber(value)).toString(16);
      else if (spec === 'o') result += Math.trunc(toNumber(value)).toString(8);
      else result += `%${spec || ''}`;
      continue;
    }
    consumeNext = false;
    result += ch;
  }
  if (index < args.length) result += ` ${args.slice(index).map(toStr).join(' ')}`;
  return result;
}

function compareValues(a, b) {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return toStr(a).localeCompare(toStr(b));
}

/**
 * The builtin registry. Each function returns a value; printing is controlled
 * by `ctx.asCommand` except for the explicit output commands echo/printf.
 */
const builtins = {
  echo: (ctx, args) => {
    const text = args.map(toStr).join(' ');
    writeln(ctx, text);
    return text;
  },

  printf: (ctx, args) => {
    if (args.length === 0) fail('printf: expected a format string', ctx);
    const text = formatPrintf(toStr(args[0]), args.slice(1));
    write(ctx, text);
    return text;
  },

  pwd: (ctx) => {
    const dir = ctx.cwd.value;
    if (ctx.asCommand) writeln(ctx, dir);
    return dir;
  },

  ls: (ctx, args) => {
    const targets = args.length > 0 ? args : ['.'];
    const results = [];
    for (const target of targets) {
      const dir = resolvePath(ctx, target);
      let entries;
      try {
        entries = fs.readdirSync(dir).sort();
      } catch (error) {
        fail(`ls: cannot read ${toStr(target)}: ${error.message}`, ctx);
      }
      for (const entry of entries) {
        results.push(path.join(toStr(target) === '.' ? '' : toStr(target), entry));
      }
    }
    if (ctx.asCommand && results.length > 0) writeln(ctx, results.join('\n'));
    return results;
  },

  cd: (ctx, args) => {
    const target = args.length > 0 ? toStr(args[0]) : ctx.cwd.value;
    const resolved = path.resolve(ctx.cwd.value, target);
    let stats;
    try {
      stats = fs.statSync(resolved);
    } catch (error) {
      fail(`cd: ${target}: ${error.message}`, ctx);
    }
    if (!stats.isDirectory()) fail(`cd: ${target}: not a directory`, ctx);
    ctx.cwd.value = resolved;
    return resolved;
  },

  cat: (ctx, args) => {
    let text;
    if (args.length === 0) {
      text = ctx.stdin;
    } else {
      text = args.map((file) => {
        try {
          return fs.readFileSync(resolvePath(ctx, file), 'utf8');
        } catch (error) {
          return fail(`cat: ${toStr(file)}: ${error.message}`, ctx);
        }
      }).join('');
    }
    if (ctx.asCommand) write(ctx, text);
    return text;
  },

  env: (ctx, args) => {
    if (args.length === 0) {
      if (ctx.asCommand) {
        const lines = Object.keys(process.env).sort().map((key) => `${key}=${process.env[key]}`);
        writeln(ctx, lines.join('\n'));
      }
      return { ...process.env };
    }
    const first = toStr(args[0]);
    if (args.length >= 2) {
      process.env[first] = toStr(args[1]);
      return toStr(args[1]);
    }
    const equal = first.indexOf('=');
    if (equal >= 0) {
      const key = first.slice(0, equal);
      const value = first.slice(equal + 1);
      process.env[key] = value;
      return value;
    }
    return process.env[first] ?? null;
  },

  set: (ctx, args) => {
    if (args.length === 0) {
      const entries = ctx.env.entries ? ctx.env.entries() : [];
      const lines = entries.map(([key, value]) => `${key}=${toStr(value)}`);
      if (ctx.asCommand) writeln(ctx, lines.join('\n'));
      return Object.fromEntries(entries);
    }
    if (args.length < 2) fail('set: expected a name and a value', ctx);
    const name = toStr(args[0]);
    ctx.env.define(name, args[1]);
    if (ctx.asCommand) writeln(ctx, `${name}=${toStr(args[1])}`);
    return args[1];
  },

  upper: (ctx, args) => {
    const value = args.length === 0 ? stdinText(ctx) : args[0];
    const result = Array.isArray(value) ? value.map((item) => toStr(item).toUpperCase()) : toStr(value).toUpperCase();
    if (ctx.asCommand) writeln(ctx, toStr(result));
    return result;
  },

  lower: (ctx, args) => {
    const value = args.length === 0 ? stdinText(ctx) : args[0];
    const result = Array.isArray(value) ? value.map((item) => toStr(item).toLowerCase()) : toStr(value).toLowerCase();
    if (ctx.asCommand) writeln(ctx, toStr(result));
    return result;
  },

  len: (ctx, args) => {
    if (args.length === 0 && !ctx.asCommand) fail('len: expected a value', ctx);
    const value = args.length === 0 ? stdinText(ctx) : args[0];
    let length;
    if (Array.isArray(value)) length = value.length;
    else if (value !== null && typeof value === 'object') length = Object.keys(value).length;
    else length = toStr(value).length;
    if (ctx.asCommand) writeln(ctx, String(length));
    return length;
  },

  split: (ctx, args) => {
    if (args.length === 0 && !ctx.asCommand) fail('split: expected a string', ctx);
    const value = args.length === 0 ? stdinText(ctx) : toStr(args[0]);
    if (args.length < 2 || args[1] === null) {
      const trimmed = value.trim();
      return trimmed === '' ? [] : trimmed.split(/\s+/);
    }
    return value.split(toStr(args[1]));
  },

  trim: (ctx, args) => {
    const value = args.length === 0 ? stdinText(ctx) : toStr(args[0]);
    const result = value.trim();
    if (ctx.asCommand) writeln(ctx, result);
    return result;
  },

  contains: (ctx, args) => {
    if (args.length < 2) fail('contains: expected a value and a search term', ctx);
    const found = Array.isArray(args[0])
      ? args[0].some((item) => valuesEqualBuiltin(item, args[1]))
      : toStr(args[0]).includes(toStr(args[1]));
    if (ctx.asCommand) writeln(ctx, found ? 'true' : 'false');
    return found;
  },

  join: (ctx, args) => {
    if (args.length === 0 || !Array.isArray(args[0])) fail('join: expected an array', ctx);
    return args[0].map(toStr).join(args.length > 1 ? toStr(args[1]) : '');
  },

  sort: (ctx, args) => {
    const values = args.length === 0
      ? ctx.stdin.split('\n').filter((line) => line !== '')
      : (args.length === 1 && Array.isArray(args[0]) ? [...args[0]] : [...args]);
    values.sort(compareValues);
    if (ctx.asCommand) writeln(ctx, values.map(toStr).join('\n'));
    return values;
  },

  range: (ctx, args) => {
    if (args.length === 0) fail('range: expected an end value', ctx);
    const first = toNumber(args[0], ctx);
    const second = args.length > 1 ? toNumber(args[1], ctx) : 0;
    const step = args.length > 2 ? toNumber(args[2], ctx) : 1;
    const start = args.length > 1 ? first : 0;
    const end = args.length > 1 ? second : first;
    if (step === 0) fail('range: step cannot be zero', ctx);
    const count = Math.ceil((end - start) / step);
    if (!Number.isFinite(count) || count > 100000) fail('range: result would be too large', ctx);
    const values = [];
    for (let i = 0; i < count; i += 1) values.push(start + i * step);
    if (ctx.asCommand) writeln(ctx, values.map(toStr).join('\n'));
    return values;
  },

  json: (ctx, args) => {
    if (args.length === 0 && ctx.asCommand) {
      try {
        const text = JSON.stringify(JSON.parse(ctx.stdin), null, 2);
        writeln(ctx, text);
        return text;
      } catch (error) {
        return fail(`json: ${error.message}`, ctx);
      }
    }
    if (args.length === 0) fail('json: expected a value', ctx);
    if (toStr(args[0]) === '--parse') {
      if (args.length < 2) fail('json --parse: expected JSON text', ctx);
      try {
        return JSON.parse(toStr(args[1]));
      } catch (error) {
        return fail(`json --parse: ${error.message}`, ctx);
      }
    }
    const text = JSON.stringify(args.length === 1 ? args[0] : args, null, 2);
    if (ctx.asCommand) writeln(ctx, text);
    return text;
  },

  time: (ctx, args) => {
    if (args.length === 0) {
      const now = new Date().toISOString();
      if (ctx.asCommand) writeln(ctx, now);
      return now;
    }
    const started = process.hrtime.bigint();
    const result = ctx.invokeCommand(args.map(toStr), ctx.stdin);
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    if (ctx.asCommand) writeln(ctx, `elapsed ${elapsedMs.toFixed(2)}ms (exit ${result.code})`);
    return result.value;
  },

  sleep: (ctx, args) => {
    if (args.length === 0) fail('sleep: expected seconds', ctx);
    const seconds = toNumber(args[0], ctx);
    if (!Number.isFinite(seconds) || seconds < 0) fail('sleep: seconds must be a non-negative number', ctx);
    sleepSync(seconds);
    return null;
  },

  exists: (ctx, args) => {
    if (args.length === 0) fail('exists: expected a path', ctx);
    const found = fs.existsSync(resolvePath(ctx, args[0]));
    if (ctx.asCommand) writeln(ctx, found ? 'true' : 'false');
    return found;
  },

  glob: (ctx, args) => {
    if (args.length === 0) fail('glob: expected a pattern', ctx);
    const pattern = toStr(args[0]);
    const slash = pattern.lastIndexOf('/');
    const directory = slash >= 0 ? pattern.slice(0, slash) || '/' : '.';
    const filePattern = slash >= 0 ? pattern.slice(slash + 1) : pattern;
    const regex = globToRegExp(filePattern);
    let matches;
    try {
      matches = fs.readdirSync(path.resolve(ctx.cwd.value, directory))
        .filter((entry) => regex.test(entry))
        .sort()
        .map((entry) => (slash >= 0 ? `${directory}/${entry}` : entry));
    } catch (error) {
      return fail(`glob: ${pattern}: ${error.message}`, ctx);
    }
    if (ctx.asCommand && matches.length > 0) writeln(ctx, matches.join('\n'));
    return matches;
  },

  read: (ctx, args) => {
    if (args.length === 0) return ctx.stdin;
    const target = resolvePath(ctx, args[0]);
    try {
      return fs.readFileSync(target, 'utf8');
    } catch (error) {
      return fail(`read: ${toStr(args[0])}: ${error.message}`, ctx);
    }
  },

  math: (ctx, args) => {
    if (args.length === 0 && !ctx.asCommand) fail('math: expected an expression string', ctx);
    const expression = args.length === 0 ? ctx.stdin : args.map(toStr).join(' ');
    const value = evaluateMath(expression);
    if (ctx.asCommand) writeln(ctx, String(value));
    return value;
  },

  args: (ctx) => {
    // Arguments supplied to the script/REPL invocation (`swift run file.shs a b`).
    const values = ctx.scriptArgs || [];
    if (ctx.asCommand) writeln(ctx, values.map(toStr).join(' '));
    return [...values];
  },

  home: (ctx) => {
    const home = ctx.home || process.env.SWIFTSHELL_HOME || path.join(require('node:os').homedir(), '.swift-shell');
    if (ctx.asCommand) writeln(ctx, home);
    return home;
  },

  isdir: (ctx, args) => {
    if (args.length === 0) fail('isdir: expected a path', ctx);
    const target = resolvePath(ctx, args[0]);
    let result = false;
    try {
      result = fs.statSync(target).isDirectory();
    } catch (error) {
      result = false;
    }
    if (ctx.asCommand) writeln(ctx, result ? 'true' : 'false');
    return result;
  },

  random: (ctx, args) => {
    const limit = args.length === 0 ? 1 : toNumber(args[0], ctx);
    if (!Number.isFinite(limit) || limit < 1) fail('random: limit must be a positive number', ctx);
    return Math.floor(Math.random() * limit);
  },

  // ---- Package manager ----------------------------------------------------

  install: (ctx, args) => {
    if (args.length === 0) fail('install: expected a package name', ctx);
    try {
      const result = new PackageManager({ home: ctx.home }).install(toStr(args[0]));
      if (ctx.asCommand) {
        writeln(ctx, result.alreadyInstalled
          ? `${result.name}@${result.version} is already installed`
          : `Installed ${result.name}@${result.version}`);
      }
      return result;
    } catch (error) {
      if (error instanceof PackageError) return fail(error.message, ctx);
      throw error;
    }
  },

  uninstall: (ctx, args) => builtins.remove(ctx, args),

  remove: (ctx, args) => {
    if (args.length === 0) fail('remove: expected a package name', ctx);
    try {
      const result = new PackageManager({ home: ctx.home }).remove(toStr(args[0]));
      if (ctx.asCommand) writeln(ctx, `Removed ${result.name}@${result.version}`);
      return result;
    } catch (error) {
      if (error instanceof PackageError) return fail(error.message, ctx);
      throw error;
    }
  },

  packages: (ctx) => {
    const installed = new PackageManager({ home: ctx.home }).installed();
    if (ctx.asCommand) {
      writeln(ctx, installed.length === 0
        ? 'No packages installed. Try: registry'
        : installed.map((item) => `${item.name}@${item.version}${item.linked ? ' (linked)' : ''}`).join('\n'));
    }
    return installed;
  },

  registry: (ctx) => {
    const available = new PackageManager({ home: ctx.home }).list();
    if (ctx.asCommand) {
      writeln(ctx, available.map((item) => `${item.name}@${item.version} — ${item.description}`).join('\n'));
    }
    return available;
  },

  search: (ctx, args) => {
    if (args.length === 0) fail('search: expected a query', ctx);
    const results = new PackageManager({ home: ctx.home }).search(args.map(toStr).join(' '));
    if (ctx.asCommand) {
      writeln(ctx, results.length === 0
        ? 'No packages matched your search.'
        : results.map((item) => `${item.name}@${item.version} — ${item.description}`).join('\n'));
    }
    return results;
  },

  info: (ctx, args) => {
    if (args.length === 0) fail('info: expected a package name', ctx);
    try {
      const entry = new PackageManager({ home: ctx.home }).info(toStr(args[0]));
      const text = [
        `${entry.name}@${entry.version}`,
        `  ${entry.description}`,
        `  category: ${entry.category || 'general'}`,
        `  author: ${entry.author || 'SwiftShell contributors'}`,
        `  keywords: ${(entry.keywords || []).join(', ')}`,
        `  files: ${Object.keys(entry.files || {}).join(', ')}`,
      ].join('\n');
      if (ctx.asCommand) writeln(ctx, text);
      return entry;
    } catch (error) {
      if (error instanceof PackageError) return fail(error.message, ctx);
      throw error;
    }
  },

  run: (ctx, args) => {
    if (args.length === 0) fail('run: expected a package name', ctx);
    try {
      const result = new PackageManager({ home: ctx.home }).run(toStr(args[0]), args.slice(1));
      const text = result.stdout;
      if (ctx.asCommand) {
        write(ctx, text);
        if (text && !text.endsWith('\n')) write(ctx, '\n');
      }
      if (result.code !== 0) fail(`run: package '${toStr(args[0])}' exited with code ${result.code}`, ctx);
      return result.value;
    } catch (error) {
      if (error instanceof PackageError) return fail(error.message, ctx);
      throw error;
    }
  },

  'pkg-update': (ctx, args) => {
    if (args.length === 0) fail('pkg-update: expected a package name', ctx);
    try {
      const result = new PackageManager({ home: ctx.home }).update(toStr(args[0]));
      if (ctx.asCommand) {
        writeln(ctx, result.updated
          ? `Updated ${result.name} to ${result.version}`
          : `${result.name} is up to date (${result.version})`);
      }
      return result;
    } catch (error) {
      if (error instanceof PackageError) return fail(error.message, ctx);
      throw error;
    }
  },

  version: (ctx) => {
    if (ctx.asCommand) writeln(ctx, `SwiftShell ${VERSION}`);
    return VERSION;
  },

  help: (ctx) => {
    const lines = [
      'SwiftShell builtins:',
      ...Object.keys(builtins).map((name) => `  ${name}`),
      '',
      'Package commands: install, uninstall, remove, packages, registry, search, info, run, pkg-update',
      'Try: echo "hello $name" | upper',
      'Docs: see README.md in the swift-shell package.',
    ];
    const text = lines.join('\n');
    if (ctx.asCommand) writeln(ctx, text);
    return text;
  },

  exit: (ctx, args) => {
    const code = args.length === 0 ? 0 : Math.trunc(toNumber(args[0], ctx));
    throw new ExitRequest(code);
  },
};

module.exports = {
  builtins,
  VERSION,
  ExitRequest,
  BuiltinError,
  evaluateMath,
  toStr,
  toNumber,
};
