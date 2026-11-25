'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const { PackageManager, PackageError } = require('../src/packages');
const { parse } = require('../src/parser');
const CLI = path.join(ROOT, 'bin', 'swiftshell.js');

function tempHome(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'swiftshell-packages-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}

function cli(code, home) {
  return spawnSync(process.execPath, [CLI, '-e', code], {
    encoding: 'utf8',
    cwd: ROOT,
    env: { ...process.env, SWIFTSHELL_HOME: home },
  });
}

test('bundled registry is complete and offline', (t) => {
  const home = tempHome(t);
  const registry = new PackageManager({ home }).list();
  assert.ok(registry.length >= 12);
  const names = registry.map((entry) => entry.name);
  for (const expected of ['hello', 'sysinfo', 'swiftfetch', 'todo', 'notes', 'wordcount', 'jsonfmt',
    'treeview', 'gitinfo', 'backup', 'countdown', 'netcheck', 'dice']) {
    assert.ok(names.includes(expected), `missing package: ${expected}`);
  }
  for (const entry of registry) {
    assert.ok(entry.version && entry.description && entry.author && entry.category && entry.keywords.length > 0);
    assert.ok(entry.files['main.shs']);
    assert.doesNotThrow(() => parse(entry.files['main.shs']), `${entry.name} should parse`);
  }
});

test('install writes files, manifest and an executable launcher', (t) => {
  const home = tempHome(t);
  const pm = new PackageManager({ home });
  const result = pm.install('hello');
  assert.equal(result.name, 'hello');
  assert.ok(fs.existsSync(path.join(home, 'packages', 'hello', '1.0.0', 'main.shs')));
  assert.ok(fs.existsSync(pm.manifestPath));
  const manifest = JSON.parse(fs.readFileSync(pm.manifestPath, 'utf8'));
  assert.equal(manifest.packages.hello.version, '1.0.0');
  const launcher = path.join(home, 'bin', 'hello');
  assert.ok(fs.existsSync(launcher));
  assert.equal(fs.statSync(launcher).mode & 0o111, 0o111);
  assert.match(fs.readFileSync(launcher, 'utf8'), /swiftshell/);
  assert.match(fs.readFileSync(launcher, 'utf8'), /main\.shs/);
});

test('install is idempotent', (t) => {
  const home = tempHome(t);
  const pm = new PackageManager({ home });
  const first = pm.install('todo');
  const second = pm.install('todo');
  assert.equal(first.alreadyInstalled, false);
  assert.equal(second.alreadyInstalled, true);
  assert.equal(pm.installed().length, 1);
});

test('installed, list, search and info work', (t) => {
  const home = tempHome(t);
  const pm = new PackageManager({ home });
  pm.install('hello');
  assert.equal(pm.installed().length, 1);
  assert.equal(pm.isInstalled('hello'), true);
  assert.ok(pm.search('git').some((entry) => entry.name === 'gitinfo'));
  assert.equal(pm.search('').length, pm.list().length);
  assert.equal(pm.info('dice').category, 'games');
});

test('run executes an installed package without network access', (t) => {
  const home = tempHome(t);
  const pm = new PackageManager({ home });
  pm.install('hello');
  const result = pm.run('hello', ['from', 'test']);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /Hello from the SwiftShell registry!/);
  assert.match(result.stdout, /from test/);
});

test('remove, update and unknown package errors', (t) => {
  const home = tempHome(t);
  const pm = new PackageManager({ home });
  assert.throws(() => pm.info('not-real'), PackageError);
  assert.throws(() => pm.install('not-real'), /Unknown package/);
  assert.throws(() => pm.remove('not-real'), /not installed/);

  pm.install('hello');
  assert.equal(pm.update('hello').updated, false);
  const removed = pm.remove('hello');
  assert.equal(removed.removed, true);
  assert.equal(pm.isInstalled('hello'), false);
  assert.equal(fs.existsSync(path.join(home, 'bin', 'hello')), false);
});

test('update installs a newer version from a custom registry', (t) => {
  const home = tempHome(t);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'swiftshell-registry-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const registryPath = path.join(directory, 'registry.json');
  const makeRegistry = (version) => ({
    packages: [{
      name: 'sample', version, description: 'Test package', author: 'Tester',
      category: 'test', keywords: ['test'], files: { 'main.shs': 'echo "v${version()}"\n' },
    }],
  });
  fs.writeFileSync(registryPath, JSON.stringify(makeRegistry('1.0.0')));
  const pm = new PackageManager({ home, registryPath });
  pm.install('sample');
  fs.writeFileSync(registryPath, JSON.stringify(makeRegistry('2.0.0')));
  const result = pm.update('sample');
  assert.deepEqual({ updated: result.updated, from: result.from, version: result.version },
    { updated: true, from: '1.0.0', version: '2.0.0' });
  assert.equal(fs.existsSync(path.join(home, 'packages', 'sample', '1.0.0')), false);
  assert.equal(pm.run('sample').stdout, 'v1.0.0\n'); // script prints SwiftShell's version()
});

test('link, publish-local and config use the home directory', (t) => {
  const home = tempHome(t);
  const pm = new PackageManager({ home });
  const source = fs.mkdtempSync(path.join(os.tmpdir(), 'swiftshell-linked-'));
  t.after(() => fs.rmSync(source, { recursive: true, force: true }));
  fs.writeFileSync(path.join(source, 'main.shs'), 'echo linked\n');
  pm.link('linked', source);
  assert.equal(pm.isInstalled('linked'), true);
  assert.match(pm.run('linked').stdout, /linked/);
  const staged = pm.publishLocal('linked');
  assert.ok(fs.existsSync(path.join(staged.path, 'main.shs')));
  pm.setConfig('theme', 'dark');
  assert.equal(pm.getConfig().theme, 'dark');
  pm.unlink('linked');
  assert.equal(pm.isInstalled('linked'), false);
});

test('package builtins work as expressions through the CLI', (t) => {
  const home = tempHome(t);
  const installed = cli('install("hello"); echo packages()', home);
  assert.equal(installed.status, 0);
  assert.match(installed.stdout, /"name":"hello"/);

  const ran = cli('echo run("hello", "expression")', home);
  assert.equal(ran.status, 0);
  assert.match(ran.stdout, /expression/);

  const searched = cli('echo search("dice")', home);
  assert.equal(searched.status, 0);
  assert.match(searched.stdout, /dice/);

  const unknown = cli('install("definitely-not-a-package")', home);
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /Unknown package/);
});
