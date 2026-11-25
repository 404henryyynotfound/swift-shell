'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parse } = require('../src/parser');
const { Interpreter, RuntimeError } = require('../src/interpreter');
const { evaluateMath } = require('../src/builtins');

function run(source, options = {}) {
  const out = [];
  const err = [];
  const interpreter = new Interpreter({
    args: options.args || [],
    cwd: options.cwd,
    home: options.home,
    stdout: (text) => out.push(String(text)),
    stderr: (text) => err.push(String(text)),
  });
  const result = interpreter.run(parse(source));
  return { result, out: out.join(''), err: err.join(''), interpreter };
}

function withTempDir(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'swiftshell-builtins-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('echo and printf emit text', () => {
  assert.equal(run('echo hello world').out, 'hello world\n');
  assert.equal(run('printf "hello %s\\n" world').out, 'hello world\n');
  assert.equal(run('printf "%d + %d = %d" 2 3 5').out, '2 + 3 = 5');
});

test('pwd, cd, ls, cat, read, exists and isdir use paths', (t) => {
  const directory = withTempDir(t);
  fs.writeFileSync(path.join(directory, 'a.txt'), 'alpha\n');
  fs.writeFileSync(path.join(directory, 'b.txt'), 'beta\n');
  fs.mkdirSync(path.join(directory, 'folder'));

  // Escape `${...}` so SwiftShell interpolation stays in the source string.
  const { out } = run(`
    cd "${directory}"
    echo "pwd: \${pwd()}"
    let entries = ls(".")
    echo "count: \${len(entries)}"
    echo "exists: \${exists("a.txt")}"
    echo "dir: \${isdir("folder")}"
    echo "content: \${cat("a.txt").trim()}"
    echo "piped: \${$(cat b.txt | trim)}"
  `);
  assert.match(out, new RegExp(`pwd: ${directory.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.match(out, /count: 3/);
  assert.match(out, /exists: true/);
  assert.match(out, /dir: true/);
  assert.match(out, /content: alpha/);
  assert.match(out, /piped: beta/);
});

test('text helpers work as commands and expressions', () => {
  assert.equal(run('echo upper("hi")').out, 'HI\n');
  assert.equal(run('echo lower("HI")').out, 'hi\n');
  assert.equal(run('echo len("hello")').out, '5\n');
  assert.equal(run('echo join(split("a,b", ","), "-")').out, 'a-b\n');
  assert.equal(run('echo sort([3, 1, 2])').out, '1 2 3\n');
  assert.equal(run('echo range(2, 6)').out, '2 3 4 5\n');
  assert.equal(run('echo contains("hello world", "world")').out, 'true\n');
  assert.equal(run('echo random(1)').out, '0\n');
});

test('json serialises and parses values', () => {
  const { out } = run(`
    let text = json([1, 2])
    let value = json("--parse", "[1, 2]")
    echo value[1]
    echo text
  `);
  assert.match(out, /2\n/);
  assert.match(out, /\[\n  1,\n  2\n\]/);
});

test('math is a safe arithmetic parser, not eval', () => {
  assert.equal(evaluateMath('2 + 3 * 4'), 14);
  assert.equal(evaluateMath('(2 + 3) * 4'), 20);
  assert.equal(evaluateMath('sqrt(9) + pow(2, 3)'), 11);
  assert.equal(evaluateMath('2 ^ 3 ^ 2'), 512);
  assert.equal(run('echo math("2 + 3 * 4")').out, '14\n');
  assert.throws(() => evaluateMath('process.exit(1)'), /unknown name/);
  assert.throws(() => evaluateMath('1 / 0'), /division by zero/);
  assert.throws(() => run('echo math("process.exit()")'), RuntimeError);
});

test('version, help, time and sleep behave', () => {
  assert.equal(run('echo version()').out, '1.0.0\n');
  assert.match(run('echo help()').out, /SwiftShell builtins/);
  const { result } = run('time()');
  assert.match(result.value, /^\d{4}-\d{2}-\d{2}T/);
  const started = Date.now();
  run('sleep 0.01');
  assert.ok(Date.now() - started >= 5);
});

test('env and set manipulate variables', () => {
  process.env.SWIFTSHELL_TEST_VALUE = undefined;
  const { out, result } = run(`
    set("localValue", 7)
    echo localValue
    env("SWIFTSHELL_TEST_VALUE", "yes")
    echo env("SWIFTSHELL_TEST_VALUE")
  `);
  assert.equal(out, '7\nyes\n');
  assert.equal(process.env.SWIFTSHELL_TEST_VALUE, 'yes');
  assert.equal(result.value, 'yes');
  delete process.env.SWIFTSHELL_TEST_VALUE;
});

test('glob, args and home expose their values', (t) => {
  const directory = withTempDir(t);
  fs.writeFileSync(path.join(directory, 'one.shs'), '');
  fs.writeFileSync(path.join(directory, 'two.shs'), '');
  fs.writeFileSync(path.join(directory, 'ignored.txt'), '');
  const { out } = run(`
    cd "${directory}"
    echo glob("*.shs")
    echo args()
    echo home()
  `, { args: ['a', 'b'], home: '/tmp/example-home' });
  assert.match(out, /one\.shs two\.shs/);
  assert.match(out, /a b/);
  assert.match(out, /\/tmp\/example-home/);
});

test('builtin errors include source positions', () => {
  assert.throws(() => run('let x = 1\necho join(1)\n'), RuntimeError);
  assert.throws(() => run('# line 1\necho math("nonsense")'), (error) => {
    assert.ok(error instanceof RuntimeError);
    assert.equal(error.line, 2);
    return true;
  });
});
