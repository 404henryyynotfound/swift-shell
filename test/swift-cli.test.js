'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const CLI = path.join(ROOT, 'bin', 'swift.js');

function swift(args, options = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    cwd: options.cwd || ROOT,
    env: { ...process.env, SWIFTSHELL_HOME: options.home || path.join(os.tmpdir(), 'swiftshell-swift-test-home') },
  });
}

function tempHome(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'swiftshell-swift-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}

test('--version, version and help', () => {
  assert.match(swift(['--version']).stdout, /SwiftShell 1\.0\.0/);
  assert.match(swift(['version']).stdout, /SwiftShell 1\.0\.0/);
  const help = swift(['--help']);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /swift <command>/);
  assert.match(swift(['help', 'install']).stdout, /Install a bundled package/);
});

test('commands lists a broad command suite', () => {
  const result = swift(['commands']);
  assert.equal(result.status, 0);
  for (const group of ['Language:', 'Packages:', 'Workspace:', 'Builtins:']) {
    assert.ok(result.stdout.includes(group));
  }
  const listed = result.stdout.split('\n').filter((line) => /^  \S/.test(line));
  assert.ok(listed.length >= 30, `expected 30+ commands, got ${listed.length}`);
  for (const name of ['eval', 'run', 'ast', 'install', 'registry', 'search', 'init', 'doctor', 'math', 'echo']) {
    assert.match(result.stdout, new RegExp(`^  ${name}\\b`, 'm'));
  }
});

test('eval and ast language commands work', () => {
  assert.equal(swift(['eval', 'echo "ok"']).stdout, 'ok\n');
  const ast = swift(['ast', '-e', 'let x = 2']);
  assert.equal(ast.status, 0);
  assert.equal(JSON.parse(ast.stdout).body[0].type, 'Let');
  const checked = swift(['check', '-e', 'echo hi']);
  assert.equal(checked.status, 0);
  assert.match(checked.stdout, /OK:/);
});

test('everyday builtins are available as passthrough commands', () => {
  assert.equal(swift(['upper', 'hello']).stdout, 'HELLO\n');
  assert.equal(swift(['lower', 'HELLO']).stdout, 'hello\n');
  assert.equal(swift(['math', '2 + 3 * 4']).stdout, '14\n');
  assert.equal(swift(['len', 'hello']).stdout, '5\n');
  assert.equal(swift(['echo', 'a', 'b']).stdout, 'a b\n');
  assert.match(swift(['pwd']).stdout, /swift-shell/);
  assert.match(swift(['json', '[1, 2]']).stdout, /1/);
});

test('package install, registry, run-pkg and aliases work', (t) => {
  const home = tempHome(t);
  const install = swift(['install', 'hello'], { home });
  assert.equal(install.status, 0);
  assert.match(install.stdout, /Installed hello@1\.0\.0/);

  assert.match(swift(['list'], { home }).stdout, /hello@1\.0\.0/);
  assert.match(swift(['registry'], { home }).stdout, /todo@/);
  assert.match(swift(['search', 'dice'], { home }).stdout, /dice@/);
  assert.match(swift(['info', 'hello'], { home }).stdout, /category: demo/);
  assert.match(swift(['run-pkg', 'hello', 'swift-cli'], { home }).stdout, /swift-cli/);
  assert.match(swift(['add', 'todo'], { home }).stdout, /Installed todo@/);
  assert.match(swift(['remove', 'hello'], { home }).stdout, /Removed hello/);
  assert.match(swift(['uninstall', 'todo'], { home }).stdout, /Removed todo/);
});

test('workspace commands emit useful output', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'swiftshell-workspace-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const init = swift(['init', 'demo'], { cwd: directory });
  assert.equal(init.status, 0);
  assert.ok(fs.existsSync(path.join(directory, 'demo', 'main.shs')));
  const newFile = swift(['new', 'extra.shs'], { cwd: directory });
  assert.equal(newFile.status, 0);
  assert.ok(fs.existsSync(path.join(directory, 'extra.shs')));
  assert.match(swift(['completion', 'bash']).stdout, /complete -W/);
  assert.match(swift(['doctor']).stdout, /registry/);
  assert.match(swift(['examples']).stdout, /hello\.shs/);
});

test('unknown subcommands suggest close matches', () => {
  const result = swift(['instl']);
  assert.equal(result.status, 127);
  assert.match(result.stderr, /unknown command 'instl'/);
  assert.match(result.stderr, /did you mean: install/);
});
