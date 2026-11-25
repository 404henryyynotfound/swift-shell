'use strict';

/**
 * swiftfetch — a neofetch-style system readout.
 *
 * Everything comes from Node built-ins (os, fs and child_process). External
 * commands are only ever invoked from a fixed allow-list with argument arrays;
 * no string from user input is passed to a shell. Every probe degrades to
 * "unknown" when the host cannot provide a value.
 */

const os = require('node:os');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

const UNKNOWN = 'unknown';
const RESET = '\u001b[0m';
const ANSI = {
  mint: '\u001b[36m',
  coral: '\u001b[31m',
  bold: '\u001b[1m',
  strip: [40, 41, 42, 43, 44, 45, 46, 47],
};

// Small 5-row block glyphs; only the letters used by SWIFT/SHELL are needed.
const GLYPHS = {
  E: ['####', '#   ', '####', '#   ', '####'],
  F: ['####', '#   ', '####', '#   ', '#   '],
  H: ['#  #', '#  #', '####', '#  #', '#  #'],
  I: ['####', ' ## ', ' ## ', ' ## ', '####'],
  L: ['#   ', '#   ', '#   ', '#   ', '####'],
  S: ['####', '#   ', '####', '   #', '####'],
  T: ['####', ' ## ', ' ## ', ' ## ', ' ## '],
  W: ['#  #', '#  #', '# ##', '## #', '#  #'],
  '?': ['####', '   #', '  # ', '    ', '  # '],
};

/** Build a five-line ASCII word from the block glyphs. */
function asciiWord(word) {
  const letters = String(word).toUpperCase().split('').map((letter) => GLYPHS[letter] || GLYPHS['?']);
  return Array.from({ length: 5 }, (_, row) => letters.map((glyph) => glyph[row]).join(' '));
}

const LOGO = Object.freeze([...asciiWord('SWIFT'), ...asciiWord('SHELL')]);

function paint(text, prefix, enabled = true) {
  return enabled ? `${prefix}${text}${RESET}` : text;
}

/** Respect NO_COLOR/FORCE_COLOR and only colourise real terminals by default. */
function defaultColor() {
  if (process.env.FORCE_COLOR) return true;
  if (process.env.NO_COLOR) return false;
  return Boolean(process.stdout && process.stdout.isTTY && process.env.TERM !== 'dumb');
}

function colorOptionFromArgs(args = []) {
  const values = Array.from(args || [], String);
  if (values.includes('--no-color')) return false;
  if (values.includes('--color')) return true;
  return undefined;
}

// ---- Formatter helpers (pure; safe to use with injected fixtures) -----------

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return UNKNOWN;
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  const amount = index === 0 ? String(Math.round(value)) : value.toFixed(1);
  return `${amount} ${units[index]}`;
}

function formatUptime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return UNKNOWN;
  const total = Math.floor(seconds);
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const parts = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (parts.length === 0) parts.push(`${secs}s`);
  else if (parts.length === 1 && days === 0 && hours === 0) parts.push(`${secs}s`);
  return parts.join(' ');
}

function formatMemory(memory) {
  if (!memory || !Number.isFinite(memory.total) || memory.total <= 0) return UNKNOWN;
  const free = Number.isFinite(memory.free) ? Math.min(memory.free, memory.total) : 0;
  const used = Math.max(0, memory.total - free);
  const percent = Math.round((used / memory.total) * 100);
  return `${formatBytes(used)} / ${formatBytes(memory.total)} (${percent}%)`;
}

function formatDisk(disk) {
  if (!disk || !Number.isFinite(disk.total) || disk.total <= 0) return UNKNOWN;
  const used = Number.isFinite(disk.used) ? Math.min(Math.max(disk.used, 0), disk.total) : 0;
  const percent = Number.isFinite(disk.percent)
    ? disk.percent
    : Math.round((used / disk.total) * 100);
  return `${formatBytes(used)} / ${formatBytes(disk.total)} (${percent}%)`;
}

function formatCpu(cpu) {
  const model = cpu && cpu.model ? String(cpu.model).replace(/\s+/g, ' ').trim() : UNKNOWN;
  const cores = cpu && Number.isFinite(cpu.cores)
    ? `${cpu.cores} core${cpu.cores === 1 ? '' : 's'}`
    : UNKNOWN;
  return `${model} (${cores})`;
}

/** The right-hand column, with stable labels so output is easy to scan/test. */
function buildInfoLines(snapshot = {}) {
  const identity = `${snapshot.user || UNKNOWN}@${snapshot.host || UNKNOWN}`;
  return [
    identity,
    '-'.repeat(Math.min(Math.max(identity.length, 12), 48)),
    `OS:        ${snapshot.osName || UNKNOWN}`,
    `Kernel:    ${snapshot.kernel || UNKNOWN}`,
    `Uptime:    ${formatUptime(snapshot.uptimeSeconds)}`,
    `Shell:     ${snapshot.shell || UNKNOWN}`,
    `Terminal:  ${snapshot.terminal || UNKNOWN}`,
    `CPU:       ${formatCpu(snapshot.cpu)}`,
    `Memory:    ${formatMemory(snapshot.memory)}`,
    `Disk:      ${formatDisk(snapshot.disk)}`,
    `Local IP:  ${snapshot.ip || UNKNOWN}`,
  ];
}

/** Eight colour blocks; plain Unicode blocks when colour is disabled. */
function colourStrip(options = {}) {
  const color = options.color === undefined ? defaultColor() : Boolean(options.color);
  return ANSI.strip
    .map((code) => (color ? `\u001b[${code}m   ${RESET}` : '███'))
    .join('');
}

/**
 * Render the complete readout from a snapshot (real or injected fixture).
 * Returns text with a single trailing newline.
 */
function renderFetch(snapshot, options = {}) {
  const color = options.color === undefined ? defaultColor() : Boolean(options.color);
  const info = buildInfoLines(snapshot || {});
  const width = LOGO.reduce((max, line) => Math.max(max, line.length), 0);
  const rows = [];

  for (let index = 0; index < Math.max(LOGO.length, info.length); index += 1) {
    const art = LOGO[index] || '';
    const detail = info[index] || '';
    const artPrefix = index < 5 ? ANSI.mint : ANSI.coral;
    const left = art
      ? paint(art.padEnd(width), artPrefix, color)
      : ' '.repeat(width);

    let right = detail;
    if (color && index === 0) right = paint(detail, `${ANSI.bold}${ANSI.mint}`);
    else if (color && index === 1) right = paint(detail, ANSI.mint);

    rows.push(`${left}  ${right}`.replace(/[ \t]+$/, ''));
  }

  rows.push('');
  rows.push(colourStrip({ color }));
  return `${rows.join('\n')}\n`;
}

// ---- Safe host probes -------------------------------------------------------

/** Run a fixed command with argument arrays; never invoke a shell string. */
function runCommand(command, args) {
  try {
    const spawned = spawnSync(command, args, {
      encoding: 'utf8',
      timeout: 2500,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    });
    if (spawned.error || spawned.status !== 0) return '';
    return spawned.stdout || '';
  } catch (_) {
    return '';
  }
}

function readOsName() {
  try {
    const text = fs.readFileSync('/etc/os-release', 'utf8');
    const match = /^PRETTY_NAME=(?:"([^"]*)"|([^\n]*))/m.exec(text);
    if (match) return (match[1] || match[2] || '').trim() || UNKNOWN;
  } catch (_) {
    // Non-Linux hosts simply use os.type()/os.release().
  }
  return `${os.type()} ${os.release()}`.trim() || UNKNOWN;
}

function terminalName() {
  const candidates = [
    process.env.TERM_PROGRAM,
    process.env.WT_SESSION ? 'Windows Terminal' : '',
    process.env.ConEmuANSI === 'ON' ? 'ConEmu' : '',
    process.env.TERM,
  ];
  const found = candidates.find((value) => typeof value === 'string' && value.trim());
  return found ? found.trim() : UNKNOWN;
}

function cpuInfo() {
  let cpus = [];
  try {
    cpus = os.cpus() || [];
  } catch (_) {
    // Fall through to availableParallelism below.
  }
  let cores = cpus.length;
  if (!cores && typeof os.availableParallelism === 'function') {
    cores = os.availableParallelism();
  }
  return {
    model: cpus.length > 0 && cpus[0].model ? cpus[0].model : UNKNOWN,
    cores: cores || UNKNOWN,
  };
}

function localIp() {
  try {
    const interfaces = os.networkInterfaces() || {};
    for (const entries of Object.values(interfaces)) {
      for (const entry of entries || []) {
        if (entry && String(entry.family).toLowerCase().includes('ipv4')
          && !entry.internal && entry.address) {
          return entry.address;
        }
      }
    }
  } catch (_) {
    // No interfaces is a normal result in some containers.
  }
  return 'none';
}

function parseDf(text, target) {
  const lines = String(text || '').split('\n').slice(1);
  for (const line of lines) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 5 || !/^\d+%$/.test(fields[4])) continue;
    const total = Number(fields[1]) * 1024;
    const used = Number(fields[2]) * 1024;
    if (!Number.isFinite(total) || total <= 0) continue;
    return { total, used, free: Math.max(0, total - used), path: target };
  }
  return null;
}

function diskUsage(target) {
  try {
    if (typeof fs.statfsSync === 'function') {
      const stats = fs.statfsSync(target);
      const total = stats.blocks * stats.bsize;
      const free = stats.bfree * stats.bsize;
      if (Number.isFinite(total) && total > 0) {
        return { total, free, used: Math.max(0, total - free), path: target };
      }
    }
  } catch (_) {
    // Older runtimes and packaged snapshots may not expose statfsSync.
  }
  return parseDf(runCommand('df', ['-k', target]), target)
    || { total: 0, free: 0, used: 0, path: target };
}

/** Collect a snapshot. Individual options override probes for testing. */
function collectSnapshot(options = {}) {
  let cwd;
  try {
    cwd = options.cwd || process.cwd();
  } catch (_) {
    cwd = '.';
  }

  let user;
  try {
    user = os.userInfo().username;
  } catch (_) {
    user = process.env.USER || process.env.USERNAME || UNKNOWN;
  }

  return {
    user: options.user || user || UNKNOWN,
    host: options.host || os.hostname() || UNKNOWN,
    osName: options.osName || readOsName(),
    kernel: options.kernel || os.release() || runCommand('uname', ['-r']) || UNKNOWN,
    uptimeSeconds: options.uptimeSeconds === undefined ? os.uptime() : options.uptimeSeconds,
    shell: options.shell || process.env.SHELL || process.env.ComSpec || process.env.COMSPEC || UNKNOWN,
    terminal: options.terminal || terminalName(),
    cpu: options.cpu || cpuInfo(),
    memory: options.memory || { total: os.totalmem(), free: os.freemem() },
    disk: options.disk || diskUsage(cwd),
    ip: options.ip || localIp(),
  };
}

/** Render and write a report (used by the builtin and direct CLI command). */
function printFetch(options = {}) {
  const snapshot = options.snapshot || collectSnapshot(options);
  const text = renderFetch(snapshot, options);
  const sink = options.out;
  if (typeof sink === 'function') sink(text);
  else (sink || process.stdout).write(text);
  return text;
}

module.exports = {
  UNKNOWN,
  ANSI,
  GLYPHS,
  LOGO,
  asciiWord,
  defaultColor,
  colorOptionFromArgs,
  formatBytes,
  formatUptime,
  formatMemory,
  formatDisk,
  formatCpu,
  buildInfoLines,
  colourStrip,
  colorStrip: colourStrip,
  renderFetch,
  collectSnapshot,
  printFetch,
  runCommand,
  parseDf,
};
