'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { parse } = require('../src/parser');
const { Interpreter, RuntimeError } = require('../src/interpreter');

const CLI = path.join(__dirname, '..', 'bin', 'swiftshell.js');

function cli(args, options = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, SWIFTSHELL_HOME: options.home || path.join(__dirname, '.test-home') },
    cwd: options.cwd || path.join(__dirname, '..'),
  });
}

test('parse errors are identified with line and column', () => {
  assert.throws(() => parse('echo "unterminated'), (error) => {
    assert.ok(error instanceof SyntaxError);
    assert.equal(error.line, 1);
    return true;
  });
  assert.throws(() => parse('if x {'), /Expected/);
});

test('runtime errors include source coordinates and a clear name', () => {
  assert.throws(() => new Interpreter().run(parse('echo (2 / 0)')), (error) => {
    assert.ok(error instanceof RuntimeError);
    assert.equal(error.name, 'RuntimeError');
    assert.match(error.message, /line 1, column \d+/);
    return true;
  });
});

test('CLI uses exit code 2 for parse errors', () => {
  const result = cli(['-e', 'let = 1']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /parse error/);
  assert.match(result.stderr, /line 1/);
});

test('CLI uses exit code 1 for runtime errors', () => {
  // A bare word in command position is a literal shell word, so use an
  // expression to force an undefined-variable error.
  const result = cli(['-e', 'let x = missingVariable']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Undefined variable/);
});

test('CLI reports missing files as runtime errors', () => {
  const result = cli(['does-not-exist.shs']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /cannot read/);
});

test('CLI success paths return zero', () => {
  assert.equal(cli(['-e', 'echo ok']).status, 0);
  assert.equal(cli(['--version']).status, 0);
  assert.equal(cli(['--help']).status, 0);
});
