'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const SWIFT = path.join(ROOT, 'bin', 'swift.js');
const SWIFTSHELL = path.join(ROOT, 'bin', 'swiftshell.js');
const { parse } = require('../src/parser');
const {
  formatBytes,
  formatUptime,
  formatMemory,
  formatDisk,
  formatCpu,
  buildInfoLines,
  renderFetch,
  colourStrip,
  asciiWord,
  collectSnapshot,
  runCommand,
} = require('../src/swiftfetch');

const GIB = 1024 ** 3;
const FIXTURE = {
  user: 'ada',
  host: 'fixture',
  osName: 'Fixture OS 1.0',
  kernel: 'fixture-kernel 1.2',
  uptimeSeconds: (2 * 86400) + (3 * 3600) + (4 * 60),
  shell: '/bin/fixture-sh',
  terminal: 'FixtureTerm',
  cpu: { model: 'Fixture CPU', cores: 8 },
  memory: { total: 16 * GIB, free: 4 * GIB },
  disk: { total: 500 * GIB, used: 125 * GIB },
  ip: '192.0.2.10',
};

function tempHome(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'swiftshell-swiftfetch-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}

function run(cli, args, home) {
  return spawnSync(process.execPath, [cli, ...args], {
    encoding: 'utf8',
    cwd: ROOT,
    env: {
      ...process.env,
      SWIFTSHELL_HOME: home || path.join(os.tmpdir(), 'swiftshell-swiftfetch-shared'),
    },
  });
}

test('the bundled offline registry advertises swiftfetch', () => {
  const registry = JSON.parse(fs.readFileSync(path.join(ROOT, 'registry.json'), 'utf8'));
  const entry = registry.packages.find((item) => item.name === 'swiftfetch');
  assert.ok(entry, 'swiftfetch must be in registry.json');
  assert.equal(entry.version, '1.0.0');
  assert.match(entry.description, /neofetch-style/i);
  assert.equal(entry.category, 'system');
  assert.ok(entry.keywords.length > 0);
  assert.ok(entry.files['main.shs']);
  assert.doesNotThrow(() => parse(entry.files['main.shs']));
});

test('formatter helpers handle injected fixtures and missing values', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(1536), '1.5 KiB');
  assert.equal(formatBytes(Number.NaN), 'unknown');
  assert.equal(formatUptime(FIXTURE.uptimeSeconds), '2d 3h 4m');
  assert.equal(formatUptime(45), '45s');
  assert.equal(formatUptime(undefined), 'unknown');
  assert.equal(formatMemory(FIXTURE.memory), '12.0 GiB / 16.0 GiB (75%)');
  assert.equal(formatMemory(null), 'unknown');
  assert.equal(formatDisk(FIXTURE.disk), '125.0 GiB / 500.0 GiB (25%)');
  assert.equal(formatDisk({ total: 100, used: 25, percent: 40 }), '25 B / 100 B (40%)');
  assert.equal(formatCpu(FIXTURE.cpu), 'Fixture CPU (8 cores)');
  assert.equal(formatCpu({ model: 'Solo CPU', cores: 1 }), 'Solo CPU (1 core)');
  assert.equal(formatCpu(null), 'unknown (unknown)');
});

test('renderFetch uses injected fixtures for every requested field', () => {
  const text = renderFetch(FIXTURE, { color: false });
  for (const expected of [
    'ada@fixture',
    'OS:        Fixture OS 1.0',
    'Kernel:    fixture-kernel 1.2',
    'Uptime:    2d 3h 4m',
    'Shell:     /bin/fixture-sh',
    'Terminal:  FixtureTerm',
    'CPU:       Fixture CPU (8 cores)',
    'Memory:    12.0 GiB / 16.0 GiB (75%)',
    'Disk:      125.0 GiB / 500.0 GiB (25%)',
    'Local IP:  192.0.2.10',
  ]) {
    assert.ok(text.includes(expected), `missing ${JSON.stringify(expected)} in:\n${text}`);
  }

  assert.equal(asciiWord('SWIFT').length, 5);
  assert.ok(text.includes(asciiWord('SWIFT')[0]));
  assert.ok(text.includes(asciiWord('SHELL')[4]));
  assert.match(colourStrip({ color: false }), /^█{24}$/);
  assert.match(text, /█{24}$/m);
  assert.equal(buildInfoLines(FIXTURE)[0], 'ada@fixture');
  assert.ok(text.endsWith('\n'));
});

test('colour mode emits ANSI logo colours and an eight-block strip', () => {
  const text = renderFetch(FIXTURE, { color: true });
  assert.match(text, /\u001b\[36m/);
  assert.match(text, /\u001b\[31m/);
  assert.match(text, /\u001b\[41m/);
  assert.equal((text.match(/\u001b\[4[0-7]m/g) || []).length, 8);
});

test('collectSnapshot accepts overrides and the safe runner does not use a shell', () => {
  const snapshot = collectSnapshot({ user: 'fixture', host: 'fixture-box' });
  assert.equal(snapshot.user, 'fixture');
  assert.equal(snapshot.host, 'fixture-box');
  assert.ok(Number.isFinite(snapshot.memory.total));
  assert.ok(typeof snapshot.cpu.cores === 'number' || snapshot.cpu.cores === 'unknown');

  const literal = 'a; echo SHOULD_NOT_RUN';
  assert.equal(
    runCommand(process.execPath, ['-e', 'process.stdout.write(process.argv[1])', literal]),
    literal,
  );
});

test('swift registry and info list swiftfetch', (t) => {
  const home = tempHome(t);
  const registry = run(SWIFT, ['registry'], home);
  assert.equal(registry.status, 0);
  assert.match(registry.stdout, /swiftfetch@1\.0\.0/);
  assert.match(run(SWIFT, ['info', 'swiftfetch'], home).stdout, /category: system/);
});

test('swift install swiftfetch then swift run-pkg swiftfetch prints the report', (t) => {
  const home = tempHome(t);
  const install = run(SWIFT, ['install', 'swiftfetch'], home);
  assert.equal(install.status, 0);
  assert.match(install.stdout, /Installed swiftfetch@1\.0\.0/);
  assert.match(run(SWIFT, ['list'], home).stdout, /swiftfetch@1\.0\.0/);

  const executed = run(SWIFT, ['run-pkg', 'swiftfetch', '--no-color'], home);
  assert.equal(executed.status, 0);
  for (const expected of ['CPU:', 'Kernel:', 'Memory:', 'Disk:', 'Local IP:', '█']) {
    assert.ok(executed.stdout.includes(expected), `missing ${expected} in package output`);
  }
});

test('swiftfetch works as a direct command and as a language builtin', (t) => {
  const home = tempHome(t);

  const direct = run(SWIFT, ['swiftfetch', '--no-color'], home);
  assert.equal(direct.status, 0);
  assert.match(direct.stdout, /OS:\s+/);
  assert.match(direct.stdout, /Shell:\s+/);

  const builtin = run(SWIFTSHELL, ['-e', 'swiftfetch'], home);
  assert.equal(builtin.status, 0);
  assert.match(builtin.stdout, /Uptime:\s+/);
  assert.match(builtin.stdout, /Terminal:\s+/);
});
