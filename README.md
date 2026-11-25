# SwiftShell

SwiftShell is a small, original terminal/shell **language** and interpreter written from scratch in JavaScript. It has **zero runtime dependencies**, runs on **Node.js 18+**, and ships with:

- `swift` — a full command front door (50+ subcommands, builtin passthrough, workspace tools). **Every command starts with `swift`.**
- `swiftshell` — a compatibility alias with the same REPL and script runner.
- A package manager with a **bundled, offline registry of 13 packages** — no network access, ever.

> **This project is unrelated to Apple Swift and to the separate `swift-browser` / `swift-tech` products.** It does not import, use or modify them. The `swift` command here is SwiftShell's own CLI.

## Install

SwiftShell is one `swift` CLI. Pick the route that fits your machine. Every
tagged release publishes stable asset names, so the `latest/download` links
below always point at the newest build. Each asset has a `.sha256` companion.

### Standalone binaries (macOS, Linux, Windows)

**Linux x64** — [swift-shell-linux-x64](https://github.com/404henryyynotfound/swift-shell/releases/latest/download/swift-shell-linux-x64)

```sh
curl -fsSL https://github.com/404henryyynotfound/swift-shell/releases/latest/download/swift-shell-linux-x64 -o swift
chmod +x swift
./swift --version
```

**Linux arm64** — [swift-shell-linux-arm64](https://github.com/404henryyynotfound/swift-shell/releases/latest/download/swift-shell-linux-arm64)

```sh
curl -fsSL https://github.com/404henryyynotfound/swift-shell/releases/latest/download/swift-shell-linux-arm64 -o swift
chmod +x swift
./swift --version
```

**macOS x64 (Intel)** — [swift-shell-macos-x64](https://github.com/404henryyynotfound/swift-shell/releases/latest/download/swift-shell-macos-x64)

```sh
curl -fsSL https://github.com/404henryyynotfound/swift-shell/releases/latest/download/swift-shell-macos-x64 -o swift
chmod +x swift
./swift --version
```

**macOS arm64 (Apple Silicon)** — [swift-shell-macos-arm64](https://github.com/404henryyynotfound/swift-shell/releases/latest/download/swift-shell-macos-arm64)

```sh
curl -fsSL https://github.com/404henryyynotfound/swift-shell/releases/latest/download/swift-shell-macos-arm64 -o swift
chmod +x swift
./swift --version
```

**Windows x64** — [swift-shell-windows-x64.exe](https://github.com/404henryyynotfound/swift-shell/releases/latest/download/swift-shell-windows-x64.exe)

```powershell
Invoke-WebRequest https://github.com/404henryyynotfound/swift-shell/releases/latest/download/swift-shell-windows-x64.exe -OutFile swift.exe
.\swift.exe --version
```

**Windows arm64** — [swift-shell-windows-arm64.exe](https://github.com/404henryyynotfound/swift-shell/releases/latest/download/swift-shell-windows-arm64.exe)

```powershell
Invoke-WebRequest https://github.com/404henryyynotfound/swift-shell/releases/latest/download/swift-shell-windows-arm64.exe -OutFile swift.exe
.\swift.exe --version
```

If a target cannot be built in a release, a `swift-shell-<platform>-<arch>.tar.gz`
fallback is published instead: it contains the JavaScript sources plus `swift`
and `swiftshell` launcher scripts. Verify any download with the matching
`.sha256` file.

### npm (anywhere Node.js 18+ runs)

```sh
npm i -g swift-shell
swift eval 'echo "hello from npm"'
swift --version   # swiftshell --version is the same CLI
```

### apt (.deb from GitHub releases)

```sh
curl -LO https://github.com/404henryyynotfound/swift-shell/releases/latest/download/swift-shell_1.0.0_amd64.deb
sudo apt install ./swift-shell_1.0.0_amd64.deb
```

For arm64, use `swift-shell_1.0.0_arm64.deb` in the same URL.

### snap

```sh
sudo snap install swift-shell
```

### Pi-Apps

Download [Swift-Shell.zip](https://github.com/404henryyynotfound/swift-shell/releases/latest/download/Swift-Shell.zip) and import the app into Pi-Apps, or run its install script directly.

### From a clone / other platforms

```sh
cd swift-shell
node bin/swift.js eval 'echo "hello"'
node bin/swift.js commands
```

npm and the [source archive](https://github.com/404henryyynotfound/swift-shell/releases/latest)
cover everything else that can run Node.js 18+.

To run installed package commands directly from your shell, add the launcher directory to your `PATH`:

```sh
echo 'export PATH="$HOME/.swift-shell/bin:$PATH"' >> ~/.bashrc   # or ~/.zshrc
```

The SwiftShell CLI and scripts automatically add `$SWIFTSHELL_HOME/bin` (default `~/.swift-shell/bin`) to `PATH` too, so `run("todo")` and `swift run-pkg todo` work even before you edit your profile.

## Language tour

Run any snippet with `swift eval '...'` or save it in a `.shs` file and run `swift run script.shs`. The older `swiftshell` alias works too.

### Variables, strings and interpolation

```shs
let name = "Ada"
echo "Hello, ${name}!"
echo 'This is literal: ${name}'   # single quotes do not interpolate
name = "Grace"
echo name.upper()
```

Double-quoted strings support `$name` and `${expression}` interpolation. Escape a dollar sign with `\$`. `#` starts a line comment.

### Numbers, arrays and expressions

```shs
let sum = 2 + 3 * 4          # 14
let values = [1, 2, 3] + [4]
echo values                  # 1 2 3 4
echo values[0]               # 1
echo math("sqrt(9) + 2 ^ 3") # 11 (safe parser; never eval)
```

Operators: `= == != > < >= <= + - * / % ! &&`. Values are numbers, strings, booleans (`true`, `false`), `null` and arrays.

### Conditionals and loops

```shs
let n = 3
if (n > 2) {
  echo "big"
} else {
  echo "small"
}

for item in [1, 2, 3] {
  if (item == 2) { continue }
  echo item
}

while (n > 0) {
  n = n - 1
  echo n
}
```

`break` and `continue` work in loops; braces are optional around a single-statement body only where the grammar allows blocks (blocks are the normal form).

### Functions and closures

```shs
fn greet(who) { return "Hi " + who }
echo greet("world")

fn makeCounter(start) {
  let count = start
  fn next() { count = count + 1; return count }
  return next
}
let counter = makeCounter(10)
echo counter()   # 11
echo counter()   # 12
```

Functions are lexical closures. Recursion works. Calls return `null` when there is no `return`.

### Commands, pipelines and redirection

```shs
echo "pipelines" | upper
printf "b\na\nc\n" | sort
echo "saved" > /tmp/swiftshell-note.txt
echo "again" >> /tmp/swiftshell-note.txt
let greeting = $(echo hello)
echo "${greeting} world"
```

Command statements fall back to a real child process (with a timeout and captured stdout/stderr/exit code), so ordinary shell tools keep working:

```shs
mkdir -p /tmp/swiftshell-demo
echo "platform: ${$(uname -s)}"
```

`&&` chains commands conditionally; `;` chains them unconditionally. A command's exit status drives `&&` short-circuiting.

### Script arguments

```shs
echo "args: ${args()}"
```

```sh
swift run script.shs one two    # args: one two
swift run script.shs one two    # same
```

## The `swift` command

`swift <subcommand> [args...]` is the primary front door. It shares the same parser, interpreter and package manager as `swiftshell`.

Language:

```sh
swift eval 'echo "ok"'          # evaluate source
swift run examples/hello.shs    # run a script
swift ast -e 'let x = 1'        # dump the AST as JSON
swift check -e 'echo hi'        # parse-check without running
swift fmt examples/hello.shs    # pretty-print a script
swift shell                     # REPL (alias: swift repl)
swift examples                  # list bundled examples
swift docs                      # point to this README
```

Packages (see below):

```sh
swift install todo              # alias: swift add todo
swift list                      # alias: swift installed
swift registry                  # bundled offline catalog
swift search git                # search names, descriptions, keywords
swift info dice                 # package details
swift run-pkg hello             # run an installed package
swift install swiftfetch        # bundled neofetch-style system report
swift run-pkg swiftfetch        # or simply: swift swiftfetch
swift update hello              # update from the bundled registry
swift remove todo               # alias: swift uninstall todo
```

Workspace:

```sh
swift init myproject            # scaffold a .shs project
swift new notes.shs             # create a script
swift completion bash           # bash/zsh/fish completion
swift config theme dark         # read/write ~/.swift-shell/config.json
swift doctor                    # installation diagnostics
swift commands                  # every command with a description
swift help                      # general help
```

Everyday builtins work as passthrough commands too:

```sh
swift echo hello
swift upper hello
swift lower HELLO
swift math "2 + 3 * 4"
swift ls .
swift json '[1, 2]'
```

An unknown subcommand first tries a builtin, then a normal external executable. If neither exists, `swift` prints a "did you mean" hint.

> Again: this `swift` binary is SwiftShell's command, not Apple Swift and not the `swift-browser` product.

## Packages

The registry is bundled in `registry.json`: **13 curated packages**, all written in SwiftShell itself. Installing copies local source text; it never downloads or runs remote code.

```sh
swift registry
swift install hello
swift run-pkg hello
swift install swiftfetch
swift run-pkg swiftfetch        # prints a neofetch-style system readout
swift install todo
~/.swift-shell/bin/todo add "try SwiftShell"
~/.swift-shell/bin/todo
```

From inside a script or REPL, every package command is also an expression-friendly builtin:

```shs
install("hello")
echo run("hello", "from", "a", "script")
echo packages()          # installed packages
echo registry()          # available packages
echo search("git")
echo info("dice")
pkg-update("hello")
```

Other package builtins: `uninstall` / `remove`. Installed packages live in `$SWIFTSHELL_HOME/packages/<name>/<version>/` with a manifest at `$SWIFTSHELL_HOME/installed.json` and launchers in `$SWIFTSHELL_HOME/bin/`. `SWIFTSHELL_HOME` overrides the default `~/.swift-shell`. Manifest writes are atomic.

Bundled packages: `hello`, `sysinfo`, `swiftfetch`, `todo`, `notes`, `wordcount`, `jsonfmt`, `treeview`, `gitinfo`, `backup`, `countdown`, `netcheck`, `dice`.

`swiftfetch` is also a first-class builtin/command: `swift swiftfetch` prints the same readout as `swift install swiftfetch && swift run-pkg swiftfetch`, and `swiftfetch` works inside scripts and the REPL. It reports user@host, OS, kernel, uptime, shell, terminal, CPU model/cores, memory, disk, local IP, an ASCII SwiftShell logo and a colour-block strip. Use `--no-color` for plain output.

## Grammar / syntax reference

```text
program        := statement*
statement      := ( let | if | for | while | fn | return | break | continue
                  | expression | pipeline ) ( (';' | '&&') statement )?
let            := 'let' IDENT '=' expression
assignment     := IDENT '=' expression                 (also an expression)
if             := 'if' '('? expression ')'? block ('else' (if | block))?
for            := 'for' IDENT 'in' expression block
while          := 'while' expression block
fn             := 'fn' IDENT '(' params? ')' block
return         := 'return' expression?
block          := '{' statement* '}'
pipeline       := command ('|' command)*
command        := word* redirection?
word           := NUMBER | STRING | IDENT | array | substitution | call | operator-literal
redirection    := ('>' | '>>') expression
expression     := IDENT '=' expression | logical-and
logical-and    := equality ('&&' equality)*
equality       := comparison (('==' | '!=') comparison)*
comparison     := additive (('<' | '>' | '<=' | '>=') additive)*
additive       := multiplicative (('+' | '-') multiplicative)*
multiplicative := unary (('*' | '/' | '%') unary)*
unary          := ('!' | '-') unary | postfix
postfix        := primary ('.' IDENT ('(' args? ')')? | '[' expression ']')*
primary        := NUMBER | STRING | IDENT | true | false | null
                | '(' expression ')' | '[' args? ']'
                | IDENT '(' args? ')' | '$(' pipeline ')'
args           := expression (',' expression)*
```

Identifiers match `[A-Za-z_][A-Za-z0-9_]*`. Numbers are decimal integers, floats or exponent forms. `#` comments run to end of line. Newlines separate statements; line breaks are ignored inside blocks, parentheses, arrays and after separators.

## Builtins

`echo`, `printf`, `pwd`, `ls`, `cd`, `cat`, `env`, `set`, `upper`, `lower`, `trim`, `len`, `split`, `join`, `sort`, `range`, `contains`, `json`, `time`, `sleep`, `exists`, `isdir`, `glob`, `read`, `math`, `random`, `args`, `home`, `version`, `swiftfetch`, `help`, `exit`, plus the package commands listed above.

Most builtins work both as commands (`upper hello`) and as expressions (`upper("hello")`). Text transforms read pipeline stdin when called with no arguments, e.g. `echo hi | upper`.

## Embedding and development

```js
const { parse, Interpreter } = require('swift-shell');
const result = new Interpreter().run(parse('echo "hello"'));
```

```sh
npm test       # node:test suites
npm run check  # syntax-check all JS files
npm run demo   # run the hello example
```

Exit codes: `0` success, `1` runtime error, `2` parse error (or bad CLI options).

## License

MIT — see [LICENSE](LICENSE).
