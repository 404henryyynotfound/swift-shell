'use strict';

/**
 * SwiftShell interpreter.
 *
 * Evaluation is synchronous and deliberately small: values are plain JS
 * numbers/strings/booleans/null plus arrays and two callable wrapper classes.
 * User code is never passed to `eval` or `new Function`.
 *
 * Output is abstracted through sinks (`out`/`err` functions). Command
 * statements always write into a capture buffer first; the pipeline driver
 * then either forwards that buffer to the real stdout, pipes it into the next
 * command as stdin, or writes it to a redirected file.
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { tokenize, TOKEN } = require('./lexer');
const { Parser, parseExpression } = require('./parser');
const { builtins, ExitRequest, BuiltinError, toStr } = require('./builtins');

/** Runtime error with source coordinates. */
class RuntimeError extends Error {
  constructor(message, node) {
    const line = node && node.line ? node.line : '?';
    const column = node && node.column ? node.column : '?';
    super(`${message} (line ${line}, column ${column})`);
    this.name = 'RuntimeError';
    this.line = line;
    this.column = column;
  }
}

/** Lexical scope: `let` defines here, assignment walks up to the owner. */
class Environment {
  constructor(parent = null) {
    this.parent = parent;
    this.vars = new Map();
  }

  lookup(name) {
    if (this.vars.has(name)) return { found: true, value: this.vars.get(name) };
    if (this.parent) return this.parent.lookup(name);
    return { found: false, value: undefined };
  }

  get(name, node) {
    const found = this.lookup(name);
    if (!found.found) throw new RuntimeError(`Undefined variable '${name}'`, node);
    return found.value;
  }

  define(name, value) {
    this.vars.set(name, value);
    return value;
  }

  set(name, value, node) {
    if (this.vars.has(name)) return this.define(name, value);
    if (this.parent && this.parent.lookup(name).found) return this.parent.set(name, value, node);
    // Assignment to an unknown name creates it in the current scope, like a
    // script language; `let` remains available for explicit local shadowing.
    return this.define(name, value);
  }

  /** All visible bindings, innermost winning (used by `set` with no args). */
  entries() {
    const result = this.parent ? new Map(this.parent.entries()) : new Map();
    for (const [key, value] of this.vars) result.set(key, value);
    return [...result.entries()];
  }
}

/** A user-defined function capturing its defining scope. */
class FunctionValue {
  constructor(name, params, body, closure) {
    this.kind = 'function';
    this.name = name;
    this.params = params;
    this.body = body;
    this.closure = closure;
  }
}

/** A builtin function value. */
class BuiltinValue {
  constructor(name, fn) {
    this.kind = 'builtin';
    this.name = name;
    this.fn = fn;
  }
}

const isCallable = (value) => value instanceof FunctionValue || value instanceof BuiltinValue;

function bufferSink() {
  const chunks = [];
  return {
    write(text) {
      chunks.push(String(text));
    },
    toString() {
      return chunks.join('');
    },
  };
}

function truthy(value) {
  if (value === null || value === undefined || value === false) return false;
  if (value === 0) return false;
  if (value === '') return false;
  if (Array.isArray(value) && value.length === 0) return false;
  return true;
}

function valuesEqual(a, b) {
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, index) => valuesEqual(item, b[index]));
  }
  return a === b;
}

function numeric(value, node) {
  if (typeof value === 'number') return value;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value === null || value === '') return 0;
  const parsed = Number(value);
  if (Number.isNaN(parsed)) throw new RuntimeError(`Expected a number, got ${JSON.stringify(toStr(value))}`, node);
  return parsed;
}

const normal = (value = null, code = 0) => ({ signal: null, value, code });
const signal = (type, value = null) => ({ signal: { type, value }, value, code: 0 });

class Interpreter {
  constructor(options = {}) {
    this.global = new Environment();
    for (const [name, fn] of Object.entries(builtins)) {
      this.global.define(name, new BuiltinValue(name, fn));
    }

    this.cwd = { value: options.cwd || process.cwd() };
    this.scriptArgs = options.args || [];
    this.home = options.home || process.env.SWIFTSHELL_HOME || path.join(require('node:os').homedir(), '.swift-shell');
    this.timeout = options.timeout === undefined ? 10000 : options.timeout;
    this.maxIterations = options.maxIterations === undefined ? 1000000 : options.maxIterations;

    this.stdout = options.stdout || ((text) => process.stdout.write(String(text)));
    this.stderr = options.stderr || ((text) => process.stderr.write(String(text)));
    this.stdin = options.stdin || '';

    this.iterationCount = 0;
    this.callDepth = 0;
    this.maxCallDepth = 256;
  }

  /** Interpret a Program or any executable AST node. */
  run(ast, options = {}) {
    const io = {
      out: options.stdout || this.stdout,
      err: options.stderr || this.stderr,
      stdin: options.stdin === undefined ? this.stdin : options.stdin,
      asCommand: false,
    };
    const env = options.env || this.global;
    const result = this.execute(ast, env, io);
    if (result.signal) {
      if (result.signal.type === 'return') {
        throw new RuntimeError('return outside of a function', ast);
      }
      throw new RuntimeError(`${result.signal.type} outside of a loop`, ast);
    }
    return result;
  }

  // ---- Statement execution ------------------------------------------------

  /** Execute a statement; returns {signal, value, code}. */
  execute(node, env, io) {
    switch (node.type) {
      case 'Program':
      case 'Block': {
        let last = normal();
        for (const statement of node.body) {
          last = this.execute(statement, env, io);
          if (last.signal) return last;
        }
        return last;
      }

      case 'Let': {
        env.define(node.name, this.evaluate(node.value, env, io));
        return normal();
      }

      case 'Assign': {
        const value = this.evaluate(node.value, env, io);
        env.set(node.name, value, node);
        return normal(value);
      }

      case 'If': {
        if (truthy(this.evaluate(node.test, env, io))) {
          return this.execute(node.consequent, env, io);
        }
        return node.alternate ? this.execute(node.alternate, env, io) : normal();
      }

      case 'While': {
        let last = normal();
        while (truthy(this.evaluate(node.test, env, io))) {
          this.tick(node);
          const result = this.execute(node.body, env, io);
          if (result.signal?.type === 'break') break;
          if (result.signal?.type === 'continue') continue;
          if (result.signal) return result;
          last = result;
        }
        return last;
      }

      case 'For': {
        const iterable = this.evaluate(node.iterable, env, io);
        const values = this.iterableValues(iterable, node);
        let last = normal();
        for (const value of values) {
          this.tick(node);
          env.define(node.name, value);
          const result = this.execute(node.body, env, io);
          if (result.signal?.type === 'break') break;
          if (result.signal?.type === 'continue') continue;
          if (result.signal) return result;
          last = result;
        }
        return last;
      }

      case 'FunctionDecl': {
        env.define(node.name, new FunctionValue(node.name, node.params, node.body, env));
        return normal();
      }

      case 'Return':
        return signal('return', node.value ? this.evaluate(node.value, env, io) : null);

      case 'Break':
        return signal('break');

      case 'Continue':
        return signal('continue');

      case 'Chain': {
        let last = normal();
        for (const step of node.steps) {
          if (step.op === 'and' && last.code !== 0) continue;
          last = this.execute(step.statement, env, io);
          if (last.signal) return last;
        }
        return last;
      }

      case 'Pipeline':
        return this.executePipeline(node, env, io);

      case 'Command':
        return this.executePipeline({ type: 'Pipeline', commands: [node], line: node.line, column: node.column }, env, io);

      case 'CommandSubstitution': {
        // Evaluated as an expression elsewhere; as a statement, discard text.
        this.evaluate(node, env, io);
        return normal();
      }

      default: {
        // Anything else is an expression statement (calls, arithmetic, ...).
        return normal(this.evaluate(node, env, io));
      }
    }
  }

  /** Guard against accidental infinite loops. */
  tick(node) {
    this.iterationCount += 1;
    if (this.iterationCount > this.maxIterations) {
      throw new RuntimeError(`Loop iteration limit (${this.maxIterations}) exceeded`, node);
    }
  }

  iterableValues(value, node) {
    if (Array.isArray(value)) return value;
    if (typeof value === 'string') return [...value];
    if (value === null || value === undefined) return [];
    if (typeof value === 'object') {
      return Object.entries(value).map(([key, item]) => [key, item]);
    }
    throw new RuntimeError(`Cannot iterate over ${typeof value}`, node);
  }

  // ---- Pipelines, redirection and external commands -----------------------

  executePipeline(node, env, io) {
    let stdin = io.stdin;
    let last = normal();
    for (const command of node.commands) {
      last = this.executeCommand(command, env, { ...io, stdin });
      stdin = last.stdout || '';
      if (last.signal) return last;
    }
    if (last.output !== undefined && !last.redirected && last.output !== '') {
      io.out(last.output);
    }
    return { signal: last.signal, value: last.value, code: last.code };
  }

  /** Evaluate words, dispatch the command, and capture its stdout. */
  executeCommand(node, env, io) {
    const sink = bufferSink();
    const commandIO = { ...io, out: sink.write, asCommand: true };
    const values = node.words.map((word) => this.evaluate(word, env, { ...io, asCommand: false }));
    const target = values[0];
    const args = values.slice(1);

    let result;
    if (isCallable(target)) {
      const value = this.callValue(target, args, commandIO, node, env);
      result = { code: 0, value, stdout: sink.toString() };
    } else {
      result = this.runExternal(toStr(target), args.map(toStr), commandIO, node);
    }

    // Builtins wrote into `sink`; external commands return their stdout in
    // `result.stdout`. Both paths converge on this single output string.
    let output = result.stdout;
    let redirected = false;
    if (node.redirect) {
      const targetPath = this.resolvePath(this.evaluate(node.redirect.target, env, { ...io, asCommand: false }), node);
      try {
        if (node.redirect.op === '>>') fs.appendFileSync(targetPath, output);
        else fs.writeFileSync(targetPath, output);
      } catch (error) {
        throw new RuntimeError(`Cannot write ${targetPath}: ${error.message}`, node);
      }
      redirected = true;
      output = '';
    }

    return {
      signal: null,
      value: result.value,
      code: result.code,
      stdout: redirected ? '' : output,
      output,
      redirected,
    };
  }

  resolvePath(target, node) {
    const value = toStr(target);
    if (!value) throw new RuntimeError('Empty file path in redirection', node);
    return path.resolve(this.cwd.value, value);
  }

  /**
   * Fallback for anything that is not a builtin/user function: a real child
   * process with a timeout and captured stdout/stderr/exit status.
   */
  runExternal(command, args, io, node) {
    let spawned;
    try {
      spawned = spawnSync(command, args, {
        cwd: this.cwd.value,
        env: process.env,
        encoding: 'utf8',
        input: io.stdin === undefined ? '' : io.stdin,
        timeout: this.timeout,
        maxBuffer: 10 * 1024 * 1024,
      });
    } catch (error) {
      throw new RuntimeError(`Failed to run '${command}': ${error.message}`, node);
    }

    if (spawned.error) {
      if (spawned.error.code === 'ENOENT') {
        io.err(`swiftshell: command not found: ${command}\n`);
        return { code: 127, value: null, stdout: '' };
      }
      const timedOut = spawned.error.code === 'ETIMEDOUT';
      io.err(`swiftshell: ${command}: ${timedOut ? 'timed out' : spawned.error.message}\n`);
      return { code: timedOut ? 124 : 1, value: null, stdout: '' };
    }

    if (spawned.stderr) io.err(spawned.stderr);
    // stdout is returned (not written here): the pipeline driver decides
    // whether to forward it, pipe it, or send it to a redirected file.
    return {
      code: spawned.status === null ? 1 : spawned.status,
      value: spawned.stdout || '',
      stdout: spawned.stdout || '',
    };
  }

  /**
   * Invoke raw command words from a builtin (used by `time`). Returns a small
   * record rather than writing directly to the caller's stdout.
   */
  invokeCommand(words, stdin = '') {
    if (!Array.isArray(words) || words.length === 0) {
      throw new BuiltinError('invokeCommand: expected command words');
    }
    const sink = bufferSink();
    const errorSink = bufferSink();
    const command = {
      type: 'Command',
      line: 1,
      column: 1,
      words: words.map((word) => ({ type: 'Literal', line: 1, column: 1, value: word })),
      redirect: null,
    };
    const result = this.executeCommand(command, this.global, {
      out: sink.write,
      err: errorSink.write,
      stdin,
      asCommand: true,
    });
    return {
      code: result.code,
      stdout: result.output,
      stderr: errorSink.toString(),
      value: result.code === 0 ? result.output.trimEnd() : result.value,
    };
  }

  // ---- Expression evaluation ---------------------------------------------

  evaluate(node, env, io) {
    switch (node.type) {
      case 'Literal':
        return node.value;

      case 'String':
        return this.evaluateString(node, env, io);

      case 'Variable': {
        const found = env.lookup(node.name);
        if (found.found) return found.value;
        if (node.bare) return node.name; // shell-like bare command word
        throw new RuntimeError(`Undefined variable '${node.name}'`, node);
      }

      case 'Array':
        return node.elements.map((element) => this.evaluate(element, env, io));

      case 'Assign': {
        const value = this.evaluate(node.value, env, io);
        env.set(node.name, value, node);
        return value;
      }

      case 'Binary':
        return this.evaluateBinary(node, env, io);

      case 'Unary': {
        const value = this.evaluate(node.argument, env, io);
        if (node.op === '!') return !truthy(value);
        if (node.op === '-') return -numeric(value, node);
        throw new RuntimeError(`Unknown unary operator '${node.op}'`, node);
      }

      case 'Member': {
        const object = this.evaluate(node.object, env, io);
        return this.memberValue(object, node.property, node);
      }

      case 'Index': {
        const object = this.evaluate(node.object, env, io);
        const index = this.evaluate(node.index, env, io);
        return this.indexValue(object, index, node);
      }

      case 'Call':
        return this.evaluateCall(node, env, io);

      case 'CommandSubstitution': {
        const sink = bufferSink();
        const errorSink = bufferSink();
        this.execute(node.body, env, {
          out: sink.write,
          err: io.err,
          stdin: io.stdin,
          asCommand: true,
        });
        return sink.toString().replace(/\n$/, '');
      }

      default:
        throw new RuntimeError(`Cannot evaluate node '${node.type}'`, node);
    }
  }

  evaluateString(node, env, io) {
    let result = '';
    for (const part of node.parts) {
      if (part.type === 'text') {
        result += part.value;
      } else if (part.type === 'var') {
        result += toStr(env.get(part.name, part));
      } else if (part.type === 'expr') {
        let expression;
        try {
          expression = parseExpression(part.source);
        } catch (error) {
          throw new RuntimeError(`Bad interpolation: ${error.message}`, part);
        }
        result += toStr(this.evaluate(expression, env, { ...io, asCommand: false }));
      }
    }
    return result;
  }

  evaluateBinary(node, env, io) {
    const left = this.evaluate(node.left, env, io);
    const right = this.evaluate(node.right, env, io);
    switch (node.op) {
      case '&&':
        return truthy(left) && truthy(right);
      case '==':
        return valuesEqual(left, right);
      case '!=':
        return !valuesEqual(left, right);
      case '<':
      case '>':
      case '<=':
      case '>=': {
        let comparison;
        if (typeof left === 'number' && typeof right === 'number') comparison = left - right;
        else comparison = toStr(left).localeCompare(toStr(right));
        if (node.op === '<') return comparison < 0;
        if (node.op === '>') return comparison > 0;
        if (node.op === '<=') return comparison <= 0;
        return comparison >= 0;
      }
      case '+':
        if (Array.isArray(left) && Array.isArray(right)) return [...left, ...right];
        if (typeof left === 'number' && typeof right === 'number') return left + right;
        if (typeof left === 'string' || typeof right === 'string') return toStr(left) + toStr(right);
        return numeric(left, node) + numeric(right, node);
      case '-':
        return numeric(left, node) - numeric(right, node);
      case '*':
        return numeric(left, node) * numeric(right, node);
      case '/': {
        const divisor = numeric(right, node);
        if (divisor === 0) throw new RuntimeError('Division by zero', node);
        return numeric(left, node) / divisor;
      }
      case '%': {
        const divisor = numeric(right, node);
        if (divisor === 0) throw new RuntimeError('Modulo by zero', node);
        return numeric(left, node) % divisor;
      }
      default:
        throw new RuntimeError(`Unknown operator '${node.op}'`, node);
    }
  }

  /** `[index]` lookup for arrays, strings and maps. */
  indexValue(object, index, node) {
    if (Array.isArray(object) || typeof object === 'string') {
      const position = numeric(index, node);
      const resolved = position < 0 ? object.length + position : position;
      if (!Number.isInteger(resolved) || resolved < 0 || resolved >= object.length) {
        throw new RuntimeError(`Index ${toStr(index)} is out of range`, node);
      }
      return object[resolved];
    }
    if (object !== null && typeof object === 'object') {
      const key = toStr(index);
      if (!(key in object)) throw new RuntimeError(`No key '${key}'`, node);
      return object[key];
    }
    throw new RuntimeError(`Cannot index a ${typeof object}`, node);
  }

  /** `.property` lookup: object fields first, then builtin method sugar. */
  memberValue(object, property, node) {
    if (object !== null && typeof object === 'object' && property in object) {
      const value = object[property];
      return isCallable(value) ? value : value;
    }
    if (Object.prototype.hasOwnProperty.call(builtins, property)) {
      return new BuiltinValue(property, builtins[property]);
    }
    throw new RuntimeError(`No method or property '${property}'`, node);
  }

  evaluateCall(node, env, io) {
    const args = node.args.map((argument) => this.evaluate(argument, env, { ...io, asCommand: false }));

    // Method sugar: `"text".upper()` becomes a call to `upper(text, ...args)`.
    if (node.callee.type === 'Member') {
      const object = this.evaluate(node.callee.object, env, io);
      const property = node.callee.property;
      let fn = null;
      if (object !== null && typeof object === 'object' && property in object) fn = object[property];
      if (!fn && Object.prototype.hasOwnProperty.call(builtins, property)) {
        fn = new BuiltinValue(property, builtins[property]);
      }
      if (!isCallable(fn)) {
        throw new RuntimeError(`'${property}' is not callable`, node.callee);
      }
      return this.callValue(
        fn,
        [object, ...args],
        { ...io, asCommand: false },
        node,
        env,
      );
    }

    const callee = this.evaluate(node.callee, env, io);
    if (!isCallable(callee)) {
      throw new RuntimeError(`${toStr(this.describeCallee(node.callee))} is not a function`, node.callee);
    }
    return this.callValue(callee, args, { ...io, asCommand: false }, node, env);
  }

  describeCallee(node) {
    if (node.type === 'Variable') return node.name;
    if (node.type === 'Literal') return toStr(node.value);
    return node.type.toLowerCase();
  }

  /** Call a function value, handling user-function signals and builtin errors. */
  callValue(callee, args, io, node, env = this.global) {
    if (callee instanceof BuiltinValue) {
      const ctx = {
        args,
        asCommand: Boolean(io.asCommand),
        out: io.out,
        err: io.err,
        stdin: io.stdin,
        env,
        cwd: this.cwd,
        line: node.line,
        column: node.column,
        scriptArgs: this.scriptArgs,
        home: this.home,
        invokeCommand: (words, stdin) => this.invokeCommand(words, stdin),
      };
      try {
        return callee.fn(ctx, args);
      } catch (error) {
        if (error instanceof BuiltinError) {
          throw new RuntimeError(error.message, node);
        }
        throw error;
      }
    }

    if (callee instanceof FunctionValue) {
      if (this.callDepth >= this.maxCallDepth) {
        throw new RuntimeError('Maximum call depth exceeded (recursive function?)', node);
      }
      if (args.length !== callee.params.length) {
        throw new RuntimeError(
          `Function '${callee.name}' expects ${callee.params.length} argument(s), got ${args.length}`,
          node,
        );
      }
      const local = new Environment(callee.closure);
      callee.params.forEach((param, index) => local.define(param, args[index]));
      this.callDepth += 1;
      try {
        const bodyIO = { ...io, asCommand: false };
        const result = this.execute(callee.body, local, bodyIO);
        if (result.signal?.type === 'return') return result.signal.value;
        if (result.signal) {
          throw new RuntimeError(`${result.signal.type} outside of a loop`, callee.body);
        }
        return result.value;
      } finally {
        this.callDepth -= 1;
      }
    }

    throw new RuntimeError('Value is not callable', node);
  }
}

module.exports = {
  Interpreter,
  Environment,
  FunctionValue,
  BuiltinValue,
  RuntimeError,
  truthy,
  valuesEqual,
  normal,
  signal,
};
