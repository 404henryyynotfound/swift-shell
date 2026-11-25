#!/usr/bin/env node
'use strict';

/**
 * `swiftshell` — the language binary.
 *
 *   swiftshell                 interactive REPL
 *   swiftshell -e 'code'       evaluate a snippet
 *   swiftshell script.shs      run a script
 *   swiftshell --ast -e 'code' dump the parsed AST as JSON
 *   swiftshell --version       print the version
 *   swiftshell --help          print usage
 */

const path = require('node:path');
const {
  VERSION,
  prepareEnvironment,
  executeSource,
  executeFile,
  startRepl,
} = require('../src/cli');

const HELP = `SwiftShell ${VERSION} — a small, dependency-free shell language

Usage:
  swiftshell                       start the interactive REPL
  swiftshell -e, --eval "<code>"   evaluate code
  swiftshell <file.shs> [args...]  run a script (script args are available via args())
  swiftshell --ast (-e "<code>" | <file.shs>)
                                   print the abstract syntax tree as JSON
  swiftshell --version, -v         print the version
  swiftshell --help, -h            print this help

Exit codes: 0 success, 1 runtime error, 2 parse error.
Run \`swift commands\` to see the full command suite.
`;

function main(argv) {
  const home = prepareEnvironment();
  let astOnly = false;
  let code = null;
  let file = null;
  let rest = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--ast') {
      astOnly = true;
    } else if (arg === '-e' || arg === '--eval') {
      code = argv[++i];
      if (code === undefined) {
        process.stderr.write('swiftshell: missing code after -e/--eval\n');
        return 2;
      }
      rest = argv.slice(i + 1);
      break;
    } else if (arg === '--version' || arg === '-v') {
      process.stdout.write(`SwiftShell ${VERSION}\n`);
      return 0;
    } else if (arg === '--help' || arg === '-h') {
      process.stdout.write(HELP);
      return 0;
    } else if (arg.startsWith('-')) {
      process.stderr.write(`swiftshell: unknown option ${arg}\n`);
      return 2;
    } else {
      file = arg;
      rest = argv.slice(i + 1);
      break;
    }
  }

  if (code !== null) {
    return executeSource(code, { args: rest, astOnly, home, prefix: 'swiftshell' });
  }
  if (file !== null) {
    if (astOnly) {
      try {
        const source = require('node:fs').readFileSync(path.resolve(process.cwd(), file), 'utf8');
        process.stdout.write(`${JSON.stringify(require('../src/cli').parseSource(source), null, 2)}\n`);
        return 0;
      } catch (error) {
        return require('../src/cli').reportError(error, 'swiftshell');
      }
    }
    return executeFile(path.resolve(process.cwd(), file), rest, { home, prefix: 'swiftshell' });
  }
  startRepl({ home });
  return 0;
}

process.exitCode = main(process.argv.slice(2));
