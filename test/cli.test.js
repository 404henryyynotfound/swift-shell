'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const CLI = path.join(ROOT, 'bin', 'swiftshell.js');

function cli(args, options = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    cwd: options.cwd || ROOT,
    env: { ...process.env, SWIFTSHELL_HOME: options.home || path.join(os.tmpdir(), 'swiftshell-cli-test-home') },
  });
}

test('-e and --eval execute code', () => {
  assert.equal(cli(['-e', 'echo "hello"']).stdout, 'hello\n');
  assert.equal(cli(['--eval', 'echo (2 + 3 * 4)']).stdout, '14\n');
});

test('--ast dumps a JSON AST', () => {
  const result = cli(['--ast', '-e', 'let x = 1']);
  assert.equal(result.status, 0);
  const ast = JSON.parse(result.stdout);
  assert.equal(ast.type, 'Program');
  assert.equal(ast.body[0].type, 'Let');
  assert.equal(ast.body[0].name, 'x');
});

test('--version and --help work', () => {
  assert.match(cli(['--version']).stdout, /SwiftShell 1\.0\.0/);
  assert.match(cli(['--help']).stdout, /swiftshell -e/);
});

test('script files receive trailing arguments', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'swiftshell-cli-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const script = path.join(directory, 'script.shs');
  fs.writeFileSync(script, 'echo "args: ${args()}"\n');
  const result = cli([script, 'one', 'two']);
  assert.equal(result.status, 0);
  assert.equal(result.stdout, 'args: one two\n');
});

test('--ast works with a script file', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'swiftshell-cli-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const script = path.join(directory, 'script.shs');
  fs.writeFileSync(script, 'echo hi\n');
  const result = cli(['--ast', script]);
  assert.equal(result.status, 0);
  assert.equal(JSON.parse(result.stdout).body[0].type, 'Command');
});

test('the CLI adds the package launcher directory to PATH', () => {
  const home = path.join(os.tmpdir(), 'swiftshell-cli-path-home');
  const pathResult = cli(['-e', 'echo "${env("PATH")}"'], { home });
  assert.equal(pathResult.status, 0);
  assert.ok(pathResult.stdout.split(path.delimiter)[0].endsWith(path.join('.swift-shell', 'bin'))
    || pathResult.stdout.split(path.delimiter)[0] === path.join(home, 'bin'));
});

test('unknown options are rejected', () => {
  const result = cli(['--nope']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /unknown option/);
});
