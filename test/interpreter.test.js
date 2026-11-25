'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parse, parseExpression } = require('../src/parser');
const { Interpreter, RuntimeError, truthy } = require('../src/interpreter');

function evaluate(source, options = {}) {
  const interpreter = new Interpreter(options);
  return interpreter.evaluate(parseExpression(source), interpreter.global, {
    out: () => {}, err: () => {}, stdin: '', asCommand: false,
  });
}

function run(source, options = {}) {
  const out = [];
  const err = [];
  const interpreter = new Interpreter({
    args: options.args || [],
    stdin: options.stdin || '',
    cwd: options.cwd,
    home: options.home,
    stdout: (text) => out.push(String(text)),
    stderr: (text) => err.push(String(text)),
  });
  const result = interpreter.run(parse(source));
  return { result, out: out.join(''), err: err.join('') };
}

test('evaluates literals, arithmetic, comparisons and strings', () => {
  assert.equal(evaluate('1 + 2 * 3'), 7);
  assert.equal(evaluate('(1 + 2) * 3'), 9);
  assert.equal(evaluate('10 / 4'), 2.5);
  assert.equal(evaluate('10 % 3'), 1);
  assert.equal(evaluate('2 > 1 && 3 <= 3'), true);
  assert.equal(evaluate('"a" + "b"'), 'ab');
  assert.equal(evaluate('[1, 2] + [3]').length, 3);
  assert.equal(evaluate('!false'), true);
  assert.equal(evaluate('-(2 + 3)'), -5);
  assert.equal(evaluate('"hello".upper()'), 'HELLO');
  assert.equal(evaluate('[10, 20][1]'), 20);
});

test('truthiness follows shell-like rules', () => {
  assert.equal(truthy(0), false);
  assert.equal(truthy(''), false);
  assert.equal(truthy(null), false);
  assert.equal(truthy([]), false);
  assert.equal(truthy(1), true);
  assert.equal(truthy('x'), true);
});

test('lexical scopes and assignment work', () => {
  const { out } = run('let x = 1; fn f() { let x = 9; return x; }; echo x; echo f()');
  assert.equal(out, '1\n9\n');
  const { out: assigned } = run('x = 4; x = x + 1; echo x');
  assert.equal(assigned, '5\n');
});

test('conditionals and loops handle break/continue', () => {
  const { out } = run(`
    for i in range(1, 6) {
      if (i == 3) { continue }
      if (i == 5) { break }
      echo i
    }
  `);
  assert.equal(out, '1\n2\n4\n');

  const nested = run(`
    let total = 0
    for i in [1, 2] {
      for j in [10, 20] {
        total = total + i * j
      }
    }
    echo total
  `);
  assert.equal(nested.out, '90\n'); // (1*10 + 1*20) + (2*10 + 2*20)
});

test('while loops and else branches work', () => {
  const { out } = run(`
    let n = 0
    while (n < 3) {
      echo n
      n = n + 1
    }
    if (false) { echo "no" } else { echo "yes" }
  `);
  assert.equal(out, '0\n1\n2\nyes\n');
});

test('functions support closures, recursion and default return', () => {
  const { out } = run(`
    fn makeCounter(start) {
      let count = start
      fn next() {
        count = count + 1
        return count
      }
      return next
    }
    let counter = makeCounter(10)
    echo counter()
    echo counter()
    fn factorial(n) {
      if (n <= 1) { return 1 }
      return n * factorial(n - 1)
    }
    echo factorial(5)
  `);
  assert.equal(out, '11\n12\n120\n');
});

test('string interpolation evaluates expressions in the current scope', () => {
  // Escape `${...}` so it reaches the SwiftShell source rather than JS.
  const { out } = run(`
    let name = "Ada"
    let n = 2
    echo "Hello \${name.upper()}, \${n * 3}!"
    echo "json: \${json([1, 2])}"
  `);
  assert.equal(out.startsWith('Hello ADA, 6!\n'), true);
  assert.match(out, /1,\n  2/);
});

test('command substitution captures stdout', () => {
  const { out } = run('let greeting = $(echo hello); echo "${greeting} world"');
  assert.equal(out, 'hello world\n');
});

test('arrays and objects can be indexed', () => {
  assert.equal(evaluate('"abc"[1]'), 'b');
  assert.equal(evaluate('[1, 2, 3][-1]'), 3);
  assert.equal(evaluate('json("--parse", "{\\"a\\": 5}")["a"]'), 5);
});

test('runtime errors carry line numbers', () => {
  assert.throws(() => run('let x = 1\n# comment\nlet y = undefinedName'), (error) => {
    assert.ok(error instanceof RuntimeError);
    assert.equal(error.line, 3);
    assert.match(error.message, /Undefined variable 'undefinedName'/);
    return true;
  });
  assert.throws(() => run('echo (1 / 0)'), /Division by zero/);
  assert.throws(() => run('fn f() { break }; f()'), /break outside of a loop/);
  assert.throws(() => run('fn f(a) { return a }; f()'), /expects 1 argument/);
});

test('user code never reaches JavaScript eval', () => {
  // A single bare word is an external command, not a JS identifier lookup.
  const { err } = run('process');
  assert.match(err, /command not found: process/);
});
