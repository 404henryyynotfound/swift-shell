'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parse } = require('../src/parser');
const { Interpreter } = require('../src/interpreter');

function run(source, options = {}) {
  const out = [];
  const err = [];
  const interpreter = new Interpreter({
    cwd: options.cwd,
    stdin: options.stdin,
    stdout: (text) => out.push(String(text)),
    stderr: (text) => err.push(String(text)),
  });
  const result = interpreter.run(parse(source));
  return { result, out: out.join(''), err: err.join(''), interpreter };
}

function tempDir(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'swiftshell-io-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('pipelines pass stdout as stdin to the next command', () => {
  assert.equal(run('echo hello | upper').out, 'HELLO\n');
  assert.equal(run('echo hello | upper | lower').out, 'hello\n');
  assert.equal(run('printf "z\\na\\nb\\n" | sort').out, 'a\nb\nz\n');
});

test('pipelines work with external commands too', () => {
  const { out } = run('printf "abc\\n" | tr a-z A-Z');
  assert.equal(out, 'ABC\n');
});

test('redirection writes files with > and >>', (t) => {
  const directory = tempDir(t);
  const target = path.join(directory, 'out.txt');
  run(`cd "${directory}"; echo first > out.txt; echo second >> out.txt`);
  assert.equal(fs.readFileSync(target, 'utf8'), 'first\nsecond\n');
});

test('redirection after a pipeline writes the final output', (t) => {
  const directory = tempDir(t);
  run(`cd "${directory}"; echo piped | upper > result.txt`);
  assert.equal(fs.readFileSync(path.join(directory, 'result.txt'), 'utf8'), 'PIPED\n');
});

test('builtins write to a capture buffer during command substitution', () => {
  // Escape `${...}` so interpolation is evaluated by SwiftShell, not JS.
  const { out } = run(`
    let who = $(echo Ada)
    echo "Hello \${who}"
    let piped = \$(echo abc | upper)
    echo "piped: \${piped}"
  `);
  assert.equal(out, 'Hello Ada\npiped: ABC\n');
});

test('redirection errors are reported as runtime errors', (t) => {
  const directory = tempDir(t);
  assert.throws(
    () => run(`cd "${directory}"; echo hi > missing/out.txt`),
    /Cannot write/,
  );
});

test('external commands capture stdout, stderr and exit code', (t) => {
  const directory = tempDir(t);
  const { result, out } = run(`cd "${directory}"; printf "外部\\n" > utf8.txt; echo done`);
  assert.equal(result.code, 0);
  assert.equal(out, 'done\n');
  assert.equal(fs.readFileSync(path.join(directory, 'utf8.txt'), 'utf8'), '外部\n');
});

test('&& short-circuits based on exit status', () => {
  const { out } = run('echo first && echo second; not-a-real-command-xyz && echo never; echo last');
  assert.equal(out, 'first\nsecond\nlast\n');
});
