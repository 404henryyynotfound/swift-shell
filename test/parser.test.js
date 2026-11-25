'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parse, parseExpression, ParserError } = require('../src/parser');

const first = (source) => parse(source).body[0];
const wordName = (word) => (word.name === undefined ? word.value : word.name);

test('parses let and assignment statements', () => {
  const declaration = first('let name = "Ada"');
  assert.equal(declaration.type, 'Let');
  assert.equal(declaration.name, 'name');
  assert.equal(declaration.value.parts[0].value, 'Ada');

  const assignment = first('name = "Grace"');
  assert.equal(assignment.type, 'Assign');
  assert.equal(assignment.name, 'name');
});

test('parses if/else, for, while and blocks', () => {
  const conditional = first('if (x > 2) { echo "big" } else { echo "small" }');
  assert.equal(conditional.type, 'If');
  assert.equal(conditional.test.op, '>');
  assert.equal(conditional.consequent.type, 'Block');
  assert.equal(conditional.alternate.type, 'Block');

  const loop = first('for item in [1, 2] { echo item; break }');
  assert.equal(loop.type, 'For');
  assert.equal(loop.name, 'item');
  assert.equal(loop.iterable.type, 'Array');
  assert.deepEqual(loop.body.body[0].steps.map((step) => step.statement.type), ['Command', 'Break']);

  const whileLoop = first('while x { continue }');
  assert.equal(whileLoop.type, 'While');
  assert.equal(whileLoop.body.body[0].type, 'Continue');
});

test('parses function declarations, returns and calls', () => {
  const fn = first('fn add(a, b) { return a + b; }');
  assert.equal(fn.type, 'FunctionDecl');
  assert.equal(fn.name, 'add');
  assert.deepEqual(fn.params, ['a', 'b']);
  assert.equal(fn.body.body[0].type, 'Return');

  const call = first('add(1, 2)');
  assert.equal(call.type, 'Call');
  assert.equal(call.callee.name, 'add');
  assert.equal(call.args.length, 2);
});

test('honours expression precedence and unary operators', () => {
  const expression = parseExpression('!a == b + 2 * 3');
  assert.equal(expression.type, 'Binary');
  assert.equal(expression.op, '==');
  assert.equal(expression.left.type, 'Unary');
  assert.equal(expression.left.op, '!');
  assert.equal(expression.right.op, '+');
  assert.equal(expression.right.right.op, '*');
});

test('parses arrays, indexing, strings and method sugar', () => {
  const array = parseExpression('[1, "two", x]');
  assert.equal(array.type, 'Array');
  assert.equal(array.elements.length, 3);

  const index = parseExpression('items[1 + 1]');
  assert.equal(index.type, 'Index');
  assert.equal(index.object.name, 'items');
  assert.equal(index.index.op, '+');

  const string = parseExpression('"hello $name"');
  assert.equal(string.type, 'String');
  assert.equal(string.parts[1].type, 'var');

  const method = parseExpression('"hello".upper()');
  assert.equal(method.type, 'Call');
  assert.equal(method.callee.type, 'Member');
  assert.equal(method.callee.property, 'upper');
});

test('parses commands, pipelines, chains and redirection', () => {
  const command = first('echo "hi"');
  assert.equal(command.type, 'Command');
  assert.deepEqual(command.words.map((word) => word.type), ['Variable', 'String']);
  assert.equal(command.words[0].bare, true);

  const pipeline = first('echo hi | upper | len');
  assert.equal(pipeline.type, 'Pipeline');
  assert.equal(pipeline.commands.length, 3);

  const chain = first('echo a && echo b; echo c');
  assert.equal(chain.type, 'Chain');
  assert.deepEqual(chain.steps.map((step) => step.op), ['seq', 'and', 'seq']);

  const redirect = first('echo hi > out.txt');
  assert.equal(redirect.redirect.op, '>');
  assert.equal(redirect.redirect.target.type, 'Literal');
  assert.equal(redirect.redirect.target.value, 'out.txt');

  const append = first('echo hi >> out.txt');
  assert.equal(append.redirect.op, '>>');
});

test('parses command substitution and interpolations', () => {
  const substitution = parseExpression('$(echo hi | upper)');
  assert.equal(substitution.type, 'CommandSubstitution');
  assert.equal(substitution.body.type, 'Pipeline');

  const interpolated = parseExpression('"value: ${1 + 2}"');
  assert.equal(interpolated.parts[1].type, 'expr');
  assert.equal(interpolated.parts[1].source, '1 + 2');
});

test('rejoins hyphenated command flags', () => {
  const command = first('git rev-parse --abbrev-ref HEAD');
  assert.deepEqual(command.words.map(wordName), ['git', 'rev-parse', '--abbrev-ref', 'HEAD']);
  const flags = first('mkdir -p output');
  assert.deepEqual(flags.words.map(wordName), ['mkdir', '-p', 'output']);
});

test('reports parse errors with source positions', () => {
  assert.throws(() => parse('let = 1'), (error) => {
    assert.ok(error instanceof ParserError);
    assert.ok(error instanceof SyntaxError);
    assert.equal(error.line, 1);
    assert.equal(error.column, 5);
    return true;
  });
  assert.throws(() => parse('if (x) { echo hi'), /Expected '}' to close block/);
});
