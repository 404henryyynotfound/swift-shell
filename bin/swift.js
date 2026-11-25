#!/usr/bin/env node
'use strict';

/**
 * `swift` — SwiftShell's primary command front door.
 *
 * The first argument selects a subcommand. Language commands delegate to the
 * shared CLI core; package commands delegate to the shared package manager;
 * every builtin is also available as a passthrough command. Anything else is
 * executed as a normal external command, with a "did you mean" hint when the
 * executable is missing.
 *
 * This `swift` binary belongs to SwiftShell only. It is unrelated to Apple
 * Swift and to the separate `swift-browser` product.
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
  VERSION,
  builtins,
  PackageManager,
  prepareEnvironment,
  reportError,
  parseSource,
  executeSource,
  executeFile,
  startRepl,
  invokeBuiltin,
  formatSource,
  suggest,
} = require('../src/cli');
const {
  renderFetch,
  collectSnapshot,
  colorOptionFromArgs,
  defaultColor,
} = require('../src/swiftfetch');

const ROOT = path.join(__dirname, '..');

/** Every command known to this CLI, with its group and description. */
const COMMANDS = Object.create(null);
function define(names, group, description, handler) {
  for (const name of names) {
    COMMANDS[name] = { name, group, description, handler };
  }
}

const list = (lines) => {
  process.stdout.write(`${lines.join('\n')}\n`);
};
const resolveFile = (file) => path.resolve(process.cwd(), file);

// ---- Language commands ----------------------------------------------------

define(['shell', 'repl'], 'Language', 'Start the interactive SwiftShell REPL', (_args, ctx) => {
  startRepl({ home: ctx.home });
  return 0;
});

define(['eval'], 'Language', 'Evaluate SwiftShell source code', (args, ctx) => {
  if (args.length === 0) {
    process.stderr.write('swift eval: expected source code\n');
    return 2;
  }
  return executeSource(args[0], { args: args.slice(1), home: ctx.home, prefix: 'swift' });
});

define(['run'], 'Language', 'Run a .shs script file', (args, ctx) => {
  if (args.length === 0) {
    process.stderr.write('swift run: expected a script file\n');
    return 2;
  }
  return executeFile(resolveFile(args[0]), args.slice(1), { home: ctx.home, prefix: 'swift' });
});

define(['ast'], 'Language', 'Print the AST of source or a script as JSON', (args, ctx) => {
  let source;
  if (args[0] === '-e' || args[0] === '--eval') {
    source = args.slice(1).join(' ');
  } else if (args[0]) {
    try {
      source = fs.readFileSync(resolveFile(args[0]), 'utf8');
    } catch (error) {
      process.stderr.write(`swift ast: ${error.message}\n`);
      return 1;
    }
  } else {
    process.stderr.write('swift ast: expected source or a file\n');
    return 2;
  }
  try {
    process.stdout.write(`${JSON.stringify(parseSource(source), null, 2)}\n`);
    return 0;
  } catch (error) {
    return reportError(error, 'swift');
  }
});

define(['check', 'lint'], 'Language', 'Parse-check source or a script (no execution)', (args, ctx) => {
  let source;
  let label = 'source';
  if (args[0] === '-e' || args[0] === '--eval') {
    source = args.slice(1).join(' ');
  } else if (args[0]) {
    label = args[0];
    try {
      source = fs.readFileSync(resolveFile(label), 'utf8');
    } catch (error) {
      process.stderr.write(`swift check: ${error.message}\n`);
      return 1;
    }
  } else {
    process.stderr.write('swift check: expected source or a file\n');
    return 2;
  }
  try {
    parseSource(source);
    list([`OK: ${label}`]);
    return 0;
  } catch (error) {
    return reportError(error, 'swift');
  }
});

define(['fmt', 'format'], 'Language', 'Format a script (use --write to overwrite)', (args) => {
  if (args.length === 0) {
    process.stderr.write('swift fmt: expected a file\n');
    return 2;
  }
  const write = args.includes('--write');
  const file = resolveFile(args.find((arg) => !arg.startsWith('--')));
  let source;
  try {
    source = fs.readFileSync(file, 'utf8');
  } catch (error) {
    process.stderr.write(`swift fmt: ${error.message}\n`);
    return 1;
  }
  const formatted = formatSource(source);
  if (write) fs.writeFileSync(file, formatted, 'utf8');
  else process.stdout.write(formatted);
  return 0;
});

define(['examples'], 'Language', 'List bundled example scripts', () => {
  const directory = path.join(ROOT, 'examples');
  const files = fs.readdirSync(directory).filter((file) => file.endsWith('.shs')).sort();
  list([...files.map((file) => path.join(directory, file)),
    '', `Run one with: swift run ${path.join('examples', files[0] || 'hello.shs')}`]);
  return 0;
});

define(['docs'], 'Language', 'Point to the bundled language documentation', () => {
  list([
    `SwiftShell documentation: ${path.join(ROOT, 'README.md')}`,
    '',
    'Language tour, grammar and package manager documentation are in README.md.',
    'Try `swift commands` for the full command list.',
  ]);
  return 0;
});

// ---- Package commands -----------------------------------------------------

define(['install', 'add'], 'Packages', 'Install a bundled package offline', (args, ctx) => {
  if (args.length === 0) {
    process.stderr.write('swift install: expected a package name\n');
    return 2;
  }
  try {
    const result = ctx.pm.install(args[0]);
    list([result.alreadyInstalled
      ? `${result.name}@${result.version} is already installed`
      : `Installed ${result.name}@${result.version}`]);
    return 0;
  } catch (error) {
    return reportError(error, 'swift');
  }
});

define(['remove', 'uninstall'], 'Packages', 'Remove an installed package', (args, ctx) => {
  if (args.length === 0) {
    process.stderr.write('swift remove: expected a package name\n');
    return 2;
  }
  try {
    const result = ctx.pm.remove(args[0]);
    list([`Removed ${result.name}@${result.version}`]);
    return 0;
  } catch (error) {
    return reportError(error, 'swift');
  }
});

define(['list', 'installed'], 'Packages', 'List installed packages', (_args, ctx) => {
  const installed = ctx.pm.installed();
  list(installed.length === 0
    ? ['No packages installed. Try: swift registry']
    : installed.map((item) => `${item.name}@${item.version}${item.linked ? ' (linked)' : ''}`));
  return 0;
});

define(['registry'], 'Packages', 'List packages in the bundled offline registry', (_args, ctx) => {
  list(ctx.pm.list().map((item) => `${item.name}@${item.version} — ${item.description}`));
  return 0;
});

define(['swiftfetch'], 'Packages', 'Print a neofetch-style SwiftShell system report', (args, ctx) => {
  const requested = colorOptionFromArgs(args);
  const color = requested === undefined ? defaultColor() : requested;
  process.stdout.write(renderFetch(collectSnapshot({ home: ctx.home }), { color }));
  return 0;
});

define(['search'], 'Packages', 'Search the bundled registry', (args, ctx) => {
  if (args.length === 0) {
    process.stderr.write('swift search: expected a query\n');
    return 2;
  }
  const results = ctx.pm.search(args.join(' '));
  list(results.length === 0
    ? ['No packages matched your search.']
    : results.map((item) => `${item.name}@${item.version} — ${item.description}`));
  return 0;
});

define(['info'], 'Packages', 'Show details about a registry package', (args, ctx) => {
  if (args.length === 0) {
    process.stderr.write('swift info: expected a package name\n');
    return 2;
  }
  try {
    const entry = ctx.pm.info(args[0]);
    list([
      `${entry.name}@${entry.version}`,
      `  ${entry.description}`,
      `  category: ${entry.category || 'general'}`,
      `  author: ${entry.author || 'SwiftShell contributors'}`,
      `  keywords: ${(entry.keywords || []).join(', ')}`,
    ]);
    return 0;
  } catch (error) {
    return reportError(error, 'swift');
  }
});

define(['update'], 'Packages', 'Update an installed package from the bundled registry', (args, ctx) => {
  if (args.length === 0) {
    process.stderr.write('swift update: expected a package name\n');
    return 2;
  }
  try {
    const result = ctx.pm.update(args[0]);
    list([result.updated
      ? `Updated ${result.name} to ${result.version}`
      : `${result.name} is up to date (${result.version})`]);
    return 0;
  } catch (error) {
    return reportError(error, 'swift');
  }
});

define(['run-pkg'], 'Packages', 'Run an installed package by name', (args, ctx) => {
  if (args.length === 0) {
    process.stderr.write('swift run-pkg: expected a package name\n');
    return 2;
  }
  try {
    const result = ctx.pm.run(args[0], args.slice(1));
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    return result.code;
  } catch (error) {
    return reportError(error, 'swift');
  }
});

define(['link'], 'Packages', 'Link a local directory as a package', (args, ctx) => {
  if (args.length < 2) {
    process.stderr.write('swift link: expected a name and a directory\n');
    return 2;
  }
  try {
    const result = ctx.pm.link(args[0], args[1]);
    list([`Linked ${result.name} -> ${result.path}`]);
    return 0;
  } catch (error) {
    return reportError(error, 'swift');
  }
});

define(['unlink'], 'Packages', 'Unlink a locally linked package', (args, ctx) => {
  if (args.length === 0) {
    process.stderr.write('swift unlink: expected a package name\n');
    return 2;
  }
  try {
    const result = ctx.pm.unlink(args[0]);
    list([`Unlinked ${result.name}`]);
    return 0;
  } catch (error) {
    return reportError(error, 'swift');
  }
});

define(['publish-local'], 'Packages', 'Stage an installed package in ~/.swift-shell/local', (args, ctx) => {
  if (args.length === 0) {
    process.stderr.write('swift publish-local: expected a package name\n');
    return 2;
  }
  try {
    const result = ctx.pm.publishLocal(args[0]);
    list([`Staged ${result.name} at ${result.path}`]);
    return 0;
  } catch (error) {
    return reportError(error, 'swift');
  }
});

// ---- Workspace commands ---------------------------------------------------

define(['init'], 'Workspace', 'Scaffold a new SwiftShell project in the current directory', (args) => {
  const directory = resolveFile(args[0] || 'swift-shell-project');
  if (fs.existsSync(directory)) {
    process.stderr.write(`swift init: ${directory} already exists\n`);
    return 1;
  }
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'main.shs'), [
    '# Generated by `swift init`',
    'echo "Hello from SwiftShell!"',
    'echo "Arguments: ${args()}"',
    '',
  ].join('\n'), 'utf8');
  fs.writeFileSync(path.join(directory, 'swift-shell.json'), `${JSON.stringify({
    name: path.basename(directory), version: '1.0.0', main: 'main.shs',
  }, null, 2)}\n`, 'utf8');
  list([`Created ${directory}`, `Run it with: swift run ${path.join(directory, 'main.shs')}`]);
  return 0;
});

define(['new'], 'Workspace', 'Create a new .shs script', (args) => {
  if (args.length === 0) {
    process.stderr.write('swift new: expected a filename\n');
    return 2;
  }
  const file = resolveFile(args[0]);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '# SwiftShell script\n\necho "Hello!"\n', { encoding: 'utf8', flag: 'wx' });
  list([`Created ${file}`]);
  return 0;
});

define(['completion'], 'Workspace', 'Emit a shell completion script (bash, zsh or fish)', (args) => {
  const shell = args[0] || 'bash';
  const names = Object.keys(COMMANDS).sort().join(' ');
  if (shell === 'bash') list([`complete -W "${names}" swift`, `complete -W "${names}" swiftshell`]);
  else if (shell === 'zsh') list([`#compdef swift swift`, `_arguments '*: :((${names}))'`]);
  else if (shell === 'fish') list([`complete -c swift -f -a '${names}'`, `complete -c swiftshell -f -a '${names}'`]);
  else {
    process.stderr.write(`swift completion: unsupported shell '${shell}' (try bash, zsh or fish)\n`);
    return 2;
  }
  return 0;
});

define(['config'], 'Workspace', 'Read or set a SwiftShell configuration value', (args, ctx) => {
  if (args.length === 0) {
    list([JSON.stringify(ctx.pm.getConfig(), null, 2)]);
  } else if (args.length === 1) {
    const value = ctx.pm.getConfig()[args[0]];
    list([value === undefined ? '(unset)' : String(value)]);
  } else {
    let value = args.slice(1).join(' ');
    if (value === 'true') value = true;
    else if (value === 'false') value = false;
    else {
      const numeric = Number(value);
      if (!Number.isNaN(numeric) && value.trim() !== '') value = numeric;
    }
    ctx.pm.setConfig(args[0], value);
    list([`${args[0]} = ${value}`]);
  }
  return 0;
});

define(['doctor'], 'Workspace', 'Check the SwiftShell installation', (_args, ctx) => {
  list(ctx.pm.doctor().map((check) => `${check.ok ? 'OK  ' : 'WARN'} ${check.name}: ${check.detail}`));
  return 0;
});

define(['version'], 'Workspace', 'Print the SwiftShell version', () => {
  list([`SwiftShell ${VERSION}`]);
  return 0;
});

define(['help'], 'Workspace', 'Show help (optionally for one command)', (args) => {
  if (args.length > 0) {
    const entry = COMMANDS[args[0]];
    if (!entry) {
      process.stderr.write(`swift help: unknown command '${args[0]}'\n`);
      return 1;
    }
    list([`swift ${entry.name} — ${entry.description}`, `Group: ${entry.group}`]);
    return 0;
  }
  list([
    `SwiftShell ${VERSION} — the swift command`,
    '',
    'Usage: swift <command> [args...]',
    '',
    'Language:    swift eval \'echo "hi"\' | swift run script.shs | swift shell',
    'Packages:    swift install todo | swift registry | swift run-pkg hello',
    '             swift install swiftfetch | swift run-pkg swiftfetch',
    'Workspace:   swift init myproject | swift completion bash | swift doctor',
    'Passthrough: any builtin, e.g. swift echo hello | swift math "2 + 3"',
    '',
    'Run `swift commands` for every available command.',
  ]);
  return 0;
});

define(['commands'], 'Workspace', 'List every command with a description', () => {
  const groups = ['Language', 'Packages', 'Workspace', 'Builtins'];
  const lines = [`SwiftShell ${VERSION} commands:`];
  for (const group of groups) {
    lines.push('', `${group}:`);
    const entries = Object.values(COMMANDS).filter((entry) => entry.group === group);
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      lines.push(`  ${entry.name.padEnd(16)} ${entry.description}`);
    }
  }
  list(lines);
  return 0;
});

// ---- Everyday builtins as passthrough commands ----------------------------

const PASSTHROUGH = {
  echo: 'Print arguments',
  printf: 'Print a formatted string',
  pwd: 'Print the working directory',
  ls: 'List paths',
  cd: 'Change the working directory',
  cat: 'Print file contents',
  env: 'Read or set environment variables',
  set: 'Read or set SwiftShell variables',
  upper: 'Convert text to upper case',
  lower: 'Convert text to lower case',
  len: 'Print the length of a value',
  split: 'Split a string into an array',
  join: 'Join an array into a string',
  sort: 'Sort values',
  range: 'Generate a range of numbers',
  json: 'Format or parse JSON',
  time: 'Print the time or time a command',
  sleep: 'Wait for a number of seconds',
  exists: 'Check whether a path exists',
  glob: 'Expand a file glob pattern',
  read: 'Read stdin or a file',
  math: 'Evaluate a safe arithmetic expression',
  version: 'Print the version',
  help: undefined, // already defined above as a workspace command
};
delete PASSTHROUGH.help;

for (const [name, description] of Object.entries(PASSTHROUGH)) {
  if (COMMANDS[name]) continue;
  define([name], 'Builtins', description, (args, ctx) => {
    invokeBuiltin(name, args, { home: ctx.home });
    return process.exitCode || 0;
  });
}

// ---- Dispatch -------------------------------------------------------------

function main(argv) {
  const home = prepareEnvironment();
  const pm = new PackageManager({ home });
  const ctx = { home, pm };

  const first = argv[0];
  if (first === '--version' || first === '-v' || first === 'version') {
    process.stdout.write(`SwiftShell ${VERSION}\n`);
    return 0;
  }
  if (first === '--help' || first === '-h') return COMMANDS.help.handler([], ctx);
  if (!first) return COMMANDS.help.handler([], ctx);

  const command = COMMANDS[first];
  if (command) return command.handler(argv.slice(1), ctx);

  // Try any builtin that was not given an explicit command entry.
  if (Object.prototype.hasOwnProperty.call(builtins, first)) {
    invokeBuiltin(first, argv.slice(1), { home });
    return process.exitCode || 0;
  }

  // Fall back to a real executable.
  const spawned = spawnSync(first, argv.slice(1), {
    stdio: 'inherit',
    env: process.env,
    cwd: process.cwd(),
  });
  if (spawned.error) {
    const hints = suggest(first, [...Object.keys(COMMANDS), ...Object.keys(builtins)]);
    process.stderr.write(`swift: unknown command '${first}'\n`);
    if (hints.length > 0) process.stderr.write(`  did you mean: ${hints.join(', ')}?\n`);
    return spawned.error.code === 'ENOENT' ? 127 : 1;
  }
  return spawned.status === null ? 1 : spawned.status;
}

process.exitCode = main(process.argv.slice(2));
