'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parse } = require('../src/parser');
const { Interpreter } = require('../src/interpreter');

function run(source, options = {}) {
  const out = [];
  const interpreter = new Interpreter({
    args: options.args || [],
    stdout: (text) => out.push(String(text)),
    stderr: () => {},
  });
  interpreter.run(parse(source));
  return out.join('');
}

test('function declarations are hoisted by definition order and callable', () => {
  const out = run(`
    fn greet(name) { return "Hi " + name }
    echo greet("Ada")
    echo greet("Grace")
  `);
  assert.equal(out, 'Hi Ada\nHi Grace\n');
});

test('recursive functions work without eval', () => {
  const out = run(`
    fn fib(n) {
      if (n <= 1) { return n }
      return fib(n - 1) + fib(n - 2)
    }
    echo fib(10)
  `);
  assert.equal(out, '55\n');
});

test('closures capture the defining scope, not the calling scope', () => {
  const out = run(`
    fn outer(x) {
      fn inner(y) { return x + y }
      return inner
    }
    let addFive = outer(5)
    let x = 100
    echo addFive(7)
  `);
  assert.equal(out, '12\n');
});

test('else-if chains and nested conditionals work', () => {
  const out = run(`
    fn classify(n) {
      if (n < 0) { return "negative" } else {
        if (n == 0) { return "zero" } else { return "positive" }
      }
    }
    echo classify(-2)
    echo classify(0)
    echo classify(3)
  `);
  assert.equal(out, 'negative\nzero\npositive\n');
});

test('for loops iterate arrays and strings; break/continue propagate', () => {
  const out = run(`
    for ch in "abc" { echo ch }
    let values = []
    for i in range(0, 6) {
      if (i % 2 == 0) { continue }
      values = values + [i]
      if (len(values) == 2) { break }
    }
    echo values
  `);
  assert.equal(out, 'a\nb\nc\n1 3\n');
});

test('while loops can use functions as conditions', () => {
  const out = run(`
    fn below(n) { return n < 3 }
    let n = 0
    while (below(n)) {
      echo n
      n = n + 1
    }
  `);
  assert.equal(out, '0\n1\n2\n');
});

test('functions can be passed around as values', () => {
  const out = run(`
    fn twice(f, x) { return f(f(x)) }
    fn inc(x) { return x + 1 }
    echo twice(inc, 5)
    let operation = inc
    echo operation(41)
  `);
  assert.equal(out, '7\n42\n');
});
