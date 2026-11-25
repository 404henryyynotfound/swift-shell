'use strict';

/**
 * SwiftShell package manager.
 *
 * The registry is bundled in `registry.json`, so installs are offline and
 * never fetch or execute remote code. Installed packages live under
 * `$SWIFTSHELL_HOME/packages/<name>/<version>/` with a manifest at
 * `$SWIFTSHELL_HOME/installed.json` and executable launchers in
 * `$SWIFTSHELL_HOME/bin/`.
 *
 * `SWIFTSHELL_HOME` overrides the default `~/.swift-shell`. All manifest
 * writes go to a temporary file in the same directory followed by an atomic
 * rename, so an interrupted write cannot corrupt the manifest.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const DEFAULT_HOME = path.join(os.homedir(), '.swift-shell');
const MANIFEST_VERSION = 1;

class PackageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PackageError';
  }
}

/** Quote a string for POSIX shells (used in generated launcher scripts). */
function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

class PackageManager {
  constructor(options = {}) {
    this.home = options.home || process.env.SWIFTSHELL_HOME || DEFAULT_HOME;
    this.registryPath = options.registryPath || path.join(__dirname, '..', 'registry.json');
    this.cliPath = options.cliPath || path.join(__dirname, '..', 'bin', 'swiftshell.js');
  }

  get packagesDir() {
    return path.join(this.home, 'packages');
  }

  get binDir() {
    return path.join(this.home, 'bin');
  }

  get manifestPath() {
    return path.join(this.home, 'installed.json');
  }

  get configPath() {
    return path.join(this.home, 'config.json');
  }

  // ---- Registry -----------------------------------------------------------

  loadRegistry() {
    let data;
    try {
      data = JSON.parse(fs.readFileSync(this.registryPath, 'utf8'));
    } catch (error) {
      throw new PackageError(`Cannot read bundled registry: ${error.message}`);
    }
    if (!data || !Array.isArray(data.packages)) {
      throw new PackageError('Bundled registry is malformed (expected a "packages" array)');
    }
    return data.packages;
  }

  list() {
    return this.loadRegistry();
  }

  search(query) {
    const needle = String(query || '').toLowerCase().trim();
    if (!needle) return this.list();
    return this.list().filter((entry) => {
      const haystack = [
        entry.name, entry.version, entry.description, entry.category, entry.author,
        ...(entry.keywords || []),
      ].join(' ').toLowerCase();
      return haystack.includes(needle);
    });
  }

  info(name) {
    const entry = this.list().find((item) => item.name === String(name));
    if (!entry) throw new PackageError(`Unknown package '${name}'. Try packages.registry() to see available packages.`);
    return entry;
  }

  // ---- Installed manifest -------------------------------------------------

  readManifest() {
    if (!fs.existsSync(this.manifestPath)) {
      return { version: MANIFEST_VERSION, packages: {} };
    }
    try {
      const data = JSON.parse(fs.readFileSync(this.manifestPath, 'utf8'));
      if (!data || typeof data !== 'object' || !data.packages) throw new Error('missing packages map');
      return data;
    } catch (error) {
      throw new PackageError(`Installed manifest is corrupt (${this.manifestPath}): ${error.message}`);
    }
  }

  /** Write JSON via a same-directory temp file + atomic rename. */
  writeJsonAtomic(file, data) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = path.join(
      path.dirname(file),
      `.${path.basename(file)}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`,
    );
    try {
      fs.writeFileSync(temporary, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
      fs.renameSync(temporary, file);
    } catch (error) {
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
      throw new PackageError(`Cannot write ${file}: ${error.message}`);
    }
  }

  installed() {
    const manifest = this.readManifest();
    return Object.values(manifest.packages);
  }

  isInstalled(name) {
    return Boolean(this.readManifest().packages[String(name)]);
  }

  // ---- Install / remove / update -----------------------------------------

  /**
   * Install a bundled package. Re-installing the same version is idempotent;
   * installing a different version replaces the manifest entry and removes
   * the superseded version directory.
   */
  install(name) {
    const entry = this.info(name);
    const version = String(entry.version);
    const target = path.join(this.packagesDir, entry.name, version);
    const manifest = this.readManifest();
    const previous = manifest.packages[entry.name];
    const alreadyInstalled = Boolean(previous && previous.version === version);

    fs.mkdirSync(target, { recursive: true });
    const written = [];
    const files = entry.files || {};
    for (const [relative, source] of Object.entries(files)) {
      if (path.isAbsolute(relative) || relative.split(/[\\/]/).includes('..')) {
        throw new PackageError(`Package '${name}' contains an unsafe file path: ${relative}`);
      }
      const destination = path.join(target, relative);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      const temporary = `${destination}.${process.pid}.tmp`;
      fs.writeFileSync(temporary, String(source), 'utf8');
      fs.renameSync(temporary, destination);
      written.push(relative);
    }

    const main = files['main.shs'] ? 'main.shs' : written[0];
    if (!main) throw new PackageError(`Package '${name}' contains no files`);

    manifest.packages[entry.name] = {
      name: entry.name,
      version,
      main,
      files: written,
      installedAt: new Date().toISOString(),
    };
    this.writeJsonAtomic(this.manifestPath, manifest);
    this.createLauncher(entry.name, version, main);

    if (previous && previous.version !== version) {
      const oldDirectory = path.join(this.packagesDir, entry.name, previous.version);
      if (oldDirectory !== target && fs.existsSync(oldDirectory)) {
        fs.rmSync(oldDirectory, { recursive: true, force: true });
      }
    }

    return {
      name: entry.name,
      version,
      path: target,
      main: path.join(target, main),
      alreadyInstalled,
    };
  }

  /** Create an executable launcher in `$SWIFTSHELL_HOME/bin`. */
  createLauncher(name, version, main) {
    fs.mkdirSync(this.binDir, { recursive: true });
    const script = path.join(this.packagesDir, name, version, main);
    // A standalone pkg binary cannot be launched through `node`; invoke the
    // binary's own `run` subcommand instead. Normal installs keep the old path.
    const fallback = process.pkg
      ? `exec ${shellQuote(process.execPath)} run ${shellQuote(script)} "$@"`
      : `exec node ${shellQuote(this.cliPath)} ${shellQuote(script)} "$@"`;
    const body = [
      '#!/bin/sh',
      `# Generated by SwiftShell for ${name}@${version}.`,
      `SWIFTSHELL_HOME=${shellQuote(this.home)}`,
      'export SWIFTSHELL_HOME',
      'if command -v swiftshell >/dev/null 2>&1; then',
      `  exec swiftshell ${shellQuote(script)} "$@"`,
      'fi',
      fallback,
      '',
    ].join('\n');
    const launcher = path.join(this.binDir, name);
    fs.writeFileSync(launcher, body, { encoding: 'utf8', mode: 0o755 });
    fs.chmodSync(launcher, 0o755);
    return launcher;
  }

  remove(name) {
    const key = String(name);
    const manifest = this.readManifest();
    const record = manifest.packages[key];
    if (!record) throw new PackageError(`Package '${key}' is not installed`);
    const directory = path.join(this.packagesDir, key);
    if (fs.existsSync(directory)) fs.rmSync(directory, { recursive: true, force: true });
    const launcher = path.join(this.binDir, key);
    if (fs.existsSync(launcher)) fs.unlinkSync(launcher);
    delete manifest.packages[key];
    this.writeJsonAtomic(this.manifestPath, manifest);
    return { name: key, version: record.version, removed: true };
  }

  uninstall(name) {
    return this.remove(name);
  }

  update(name) {
    const key = String(name);
    const entry = this.info(key); // clear error for unknown packages
    const record = this.readManifest().packages[key];
    if (!record) {
      const installed = this.install(key);
      return { name: key, version: installed.version, updated: true, newlyInstalled: true };
    }
    if (record.version === String(entry.version)) {
      return { name: key, version: record.version, updated: false };
    }
    const installed = this.install(key);
    return { name: key, version: installed.version, updated: true, from: record.version };
  }

  /** Link a local directory as an installed package (no network involved). */
  link(name, source) {
    const key = String(name);
    const sourceDir = path.resolve(this.home, String(source));
    if (!fs.existsSync(sourceDir) || !fs.statSync(sourceDir).isDirectory()) {
      throw new PackageError(`Cannot link '${source}': not a directory`);
    }
    const main = fs.existsSync(path.join(sourceDir, 'main.shs')) ? 'main.shs' : null;
    if (!main) throw new PackageError(`Cannot link '${source}': missing main.shs`);
    const manifest = this.readManifest();
    manifest.packages[key] = {
      name: key,
      version: 'local',
      main,
      files: [main],
      linked: true,
      path: sourceDir,
      installedAt: new Date().toISOString(),
    };
    this.writeJsonAtomic(this.manifestPath, manifest);
    fs.mkdirSync(this.binDir, { recursive: true });
    const launcher = path.join(this.binDir, key);
    fs.writeFileSync(launcher, [
      '#!/bin/sh',
      '# Linked SwiftShell package.',
      `SWIFTSHELL_HOME=${shellQuote(this.home)}`,
      'export SWIFTSHELL_HOME',
      `exec node ${shellQuote(this.cliPath)} ${shellQuote(path.join(sourceDir, main))} "$@"`,
      '',
    ].join('\n'), { encoding: 'utf8', mode: 0o755 });
    fs.chmodSync(launcher, 0o755);
    return { name: key, version: 'local', linked: true, path: sourceDir };
  }

  unlink(name) {
    return this.remove(name);
  }

  /** Stage an installed package into `$SWIFTSHELL_HOME/local/` for sharing. */
  publishLocal(name) {
    const key = String(name);
    const record = this.readManifest().packages[key];
    if (!record) throw new PackageError(`Package '${key}' is not installed`);
    const source = record.linked ? record.path : path.join(this.packagesDir, key, record.version);
    const destination = path.join(this.home, 'local', key);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.rmSync(destination, { recursive: true, force: true });
    fs.cpSync(source, destination, { recursive: true });
    return { name: key, path: destination };
  }

  /** Run an installed package's main script with our own CLI (not remote code). */
  run(name, args = []) {
    const key = String(name);
    const record = this.readManifest().packages[key];
    if (!record) throw new PackageError(`Package '${key}' is not installed. Install it first with install("${key}").`);
    const main = record.linked
      ? path.join(record.path, record.main)
      : path.join(this.packagesDir, key, record.version, record.main);
    if (!fs.existsSync(main)) throw new PackageError(`Package '${key}' is missing its main script: ${main}`);

    // Inside a standalone pkg binary `process.execPath` is the binary itself,
    // so pass the script through its `run` subcommand instead of a virtual path.
    // pkg's child-process shim injects PKG_EXECPATH, which makes the child treat
    // the first argument as a script to load; clearing it forces the child to
    // boot its embedded CLI and dispatch normally.
    const spawnArgs = process.pkg
      ? ['run', main, ...args.map((arg) => String(arg))]
      : [this.cliPath, main, ...args.map((arg) => String(arg))];
    const spawned = spawnSync(process.execPath, spawnArgs, {
      encoding: 'utf8',
      cwd: process.cwd(),
      env: { ...process.env, SWIFTSHELL_HOME: this.home, ...(process.pkg ? { PKG_EXECPATH: '' } : {}) },
      timeout: 30000,
      maxBuffer: 10 * 1024 * 1024,
    });
    if (spawned.error) throw new PackageError(`Failed to run '${key}': ${spawned.error.message}`);
    return {
      code: spawned.status === null ? 1 : spawned.status,
      stdout: spawned.stdout || '',
      stderr: spawned.stderr || '',
      value: (spawned.stdout || '').trimEnd(),
    };
  }

  // ---- Config and diagnostics --------------------------------------------

  getConfig() {
    if (!fs.existsSync(this.configPath)) return {};
    try {
      return JSON.parse(fs.readFileSync(this.configPath, 'utf8'));
    } catch (error) {
      throw new PackageError(`Config file is invalid: ${error.message}`);
    }
  }

  setConfig(key, value) {
    const config = this.getConfig();
    config[String(key)] = value === undefined ? true : value;
    this.writeJsonAtomic(this.configPath, config);
    return config[String(key)];
  }

  doctor() {
    const checks = [
      { name: 'node', ok: Number(process.versions.node.split('.')[0]) >= 18, detail: process.version },
      { name: 'registry', ok: this.list().length > 0, detail: `${this.list().length} bundled packages` },
      { name: 'home directory', ok: fs.existsSync(this.home), detail: this.home },
      { name: 'installed manifest', ok: fs.existsSync(this.manifestPath), detail: this.manifestPath },
      { name: 'launcher directory on PATH', ok: (process.env.PATH || '').split(path.delimiter).includes(this.binDir), detail: this.binDir },
    ];
    return checks;
  }
}

module.exports = { PackageManager, PackageError, DEFAULT_HOME, shellQuote };
