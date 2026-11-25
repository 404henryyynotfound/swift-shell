'use strict';

/**
 * Shared CLI plumbing for the two SwiftShell front doors:
 *   swiftshell  - the language-focused binary
 *   swift       - the command-suite binary (subcommands + passthrough)
 *
 * Keeping parsing, error formatting, PATH setup and REPL handling here means
 * both binaries behave identically and share one interpreter.
 */

const fs = require('node:fs');
const path = require('node:path');

const { tokenize } = require('./lexer');
const { parse } = require('./parser');
const { Interpreter, RuntimeError } = require('./interpreter');
const { builtins, ExitRequest, VERSION } = require('./builtins');
const { PackageManager, DEFAULT_HOME } = require('./packages');

/** Add the package launchers directory to PATH before running any script. */
function prepareEnvironment() {
  const home = process.env.SWIFTSHELL_HOME || DEFAULT_HOME;
  const launchers = [path.join(home, 'bin'), path.join(DEFAULT_HOME, 'bin')];
  const current = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  process.env.PATH = [...launchers, ...current.filter((entry) => !launchers.includes(entry))].join(path.delimiter);
  return home;
}

/** Print an error in a consistent format and return its process exit code. */
function reportError(error, prefix = 'swiftshell') {
  if (error instanceof ExitRequest) return error.code;
  if (error instanceof SyntaxError) {
    process.stderr.write(`${prefix}: parse error: ${error.message}\n`);
    return 2;
  }
  if (error instanceof RuntimeError) {
    process.stderr.write(`${prefix}: ${error.message}\n`);
    return 1;
  }
  process.stderr.write(`${prefix}: ${error && error.message ? error.message : String(error)}\n`);
  return 1;
}

/** Parse source (used by --ast, --check and the formatters). */
function parseSource(source) {
  return parse(source);
}

/** Execute source text and return an exit code. */
function executeSource(source, options = {}) {
  try {
    const ast = parse(source);
    if (options.astOnly) {
      process.stdout.write(`${JSON.stringify(ast, null, 2)}\n`);
      return 0;
    }
    const interpreter = new Interpreter({
      args: options.args || [],
      home: options.home || prepareEnvironment(),
      stdin: options.stdin === undefined ? '' : options.stdin,
      cwd: options.cwd || process.cwd(),
    });
    interpreter.run(ast, options.env ? { env: options.env } : {});
    return 0;
  } catch (error) {
    return reportError(error, options.prefix);
  }
}

/** Execute a script file with the given argv tail. */
function executeFile(filename, args, options = {}) {
  let source;
  try {
    source = fs.readFileSync(filename, 'utf8');
  } catch (error) {
    process.stderr.write(`swiftshell: cannot read ${filename}: ${error.message}\n`);
    return 1;
  }
  return executeSource(source, { ...options, args });
}

/**
 * A compact token-based formatter. It normalises spacing and indentation;
 * comments are not preserved (the lexer intentionally discards them).
 */
function formatSource(source) {
  const tokens = tokenize(source).filter((token) => token.type !== 'NEWLINE' && token.type !== 'EOF');
  let output = '';
  let indent = 0;
  let previous = null;

  const newline = () => {
    if (output !== '' && !output.endsWith('\n')) output += '\n';
  };
  const pad = () => {
    if (output.endsWith('\n')) output += '  '.repeat(indent);
  };

  for (const token of tokens) {
    const value = String(token.value);
    if (value === '}') {
      indent = Math.max(0, indent - 1);
      newline();
      pad();
      output += '}';
      previous = token;
      continue;
    }
    if (value === '{') {
      pad();
      if (output && !output.endsWith(' ') && !output.endsWith('\n')) output += ' ';
      output += '{';
      indent += 1;
      newline();
      previous = token;
      continue;
    }
    if (value === ';') {
      output = output.replace(/ +$/, '');
      output += ';';
      newline();
      previous = token;
      continue;
    }
    pad();
    if (value === ')' || value === ']' || value === ',') {
      output = output.replace(/ +$/, '');
      output += value;
      if (value === ',') output += ' ';
    } else if (value === '(' || value === '[' || value === '$(') {
      output += value;
    } else if (token.type === 'OP' || token.type === 'PUNCT') {
      if (output && !output.endsWith(' ') && !output.endsWith('\n')) output += ' ';
      output += value;
      output += ' ';
    } else {
      if (output && !output.endsWith(' ') && !output.endsWith('\n') && previous && previous.type !== 'PUNCT') {
        output += ' ';
      }
      output += value;
    }
    previous = token;
  }
  return `${output.trimEnd()}\n`;
}

/** Interactive REPL with readline history. */
function startRepl(options = {}) {
  const readline = require('node:readline');
  const home = options.home || prepareEnvironment();
  const historyFile = path.join(home, 'history');
  const interpreter = new Interpreter({
    home,
    args: [],
    stdin: '',
    stdout: (text) => process.stdout.write(String(text)),
    stderr: (text) => process.stderr.write(String(text)),
  });
  const env = interpreter.global;

  try {
    if (fs.existsSync(historyFile)) {
      const lines = fs.readFileSync(historyFile, 'utf8').split('\n').filter(Boolean);
      // readline only accepts history after the interface is created.
      interpreter.__pendingHistory = lines;
    }
  } catch (_) {
    // History is a convenience, never a reason to refuse to start.
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: 'swiftshell> ',
    terminal: Boolean(process.stdin.isTTY),
  });
  if (interpreter.__pendingHistory) {
    rl.history = interpreter.__pendingHistory;
    delete interpreter.__pendingHistory;
  }

  let pending = '';
  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (trimmed === '') return;
    if (trimmed === 'exit' || trimmed === 'quit') {
      rl.close();
      return;
    }
    pending += `${line}\n`;
    const opens = (pending.match(/[{([]/g) || []).length;
    const closes = (pending.match(/[})\]]/g) || []).length;
    if (opens > closes) {
      rl.setPrompt('   ...> ');
      rl.prompt();
      return;
    }
    const source = pending;
    pending = '';
    rl.setPrompt('swiftshell> ');
    try {
      interpreter.run(parse(source), { env });
    } catch (error) {
      if (error instanceof ExitRequest) {
        process.exitCode = error.code;
        rl.close();
        return;
      }
      process.stderr.write(`${reportError(error)}\n`);
    }
    rl.prompt();
  });

  rl.on('close', () => {
    try {
      fs.mkdirSync(home, { recursive: true });
      fs.writeFileSync(historyFile, `${rl.history.slice(-200).join('\n')}\n`, 'utf8');
    } catch (_) {
      // Ignore history write failures (read-only home, etc.).
    }
    process.stdout.write('\n');
  });

  rl.prompt();
  return rl;
}

/** Invoke a builtin directly (used by `swift <builtin>` passthrough). */
function invokeBuiltin(name, args, options = {}) {
  const interp = new Interpreter({
    home: options.home || prepareEnvironment(),
    stdout: (text) => process.stdout.write(String(text)),
    stderr: (text) => process.stderr.write(String(text)),
  });
  const found = interp.global.lookup(name);
  if (!found.found || !found.value || found.value.kind !== 'builtin') return false;
  try {
    found.value.fn({
      args,
      asCommand: true,
      out: (text) => process.stdout.write(String(text)),
      err: (text) => process.stderr.write(String(text)),
      stdin: '',
      env: interp.global,
      cwd: interp.cwd,
      scriptArgs: [],
      home: interp.home,
      invokeCommand: (words, stdin) => interp.invokeCommand(words, stdin),
    }, args);
    return true;
  } catch (error) {
    process.exitCode = reportError(error, 'swift');
    return true;
  }
}

/** Levenshtein distance, used for "did you mean" suggestions. */
function editDistance(a, b) {
  const rows = Array.from({ length: a.length + 1 }, (_, index) => [index]);
  for (let j = 0; j <= b.length; j += 1) rows[0][j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      rows[i][j] = Math.min(
        rows[i - 1][j] + 1,
        rows[i][j - 1] + 1,
        rows[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
  }
  return rows[a.length][b.length];
}

function suggest(name, candidates) {
  const ranked = candidates
    .map((candidate) => ({ candidate, distance: editDistance(name, candidate) }))
    .filter((item) => item.distance <= Math.max(2, Math.floor(name.length / 3)))
    .sort((a, b) => a.distance - b.distance)
    .slice(0, 3)
    .map((item) => item.candidate);
  return ranked;
}

module.exports = {
  VERSION,
  DEFAULT_HOME,
  builtins,
  PackageManager,
  prepareEnvironment,
  reportError,
  parseSource,
  executeSource,
  executeFile,
  formatSource,
  startRepl,
  invokeBuiltin,
  suggest,
};
