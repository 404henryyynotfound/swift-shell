'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { tokenize, TOKEN, LexerError } = require('../src/lexer');

const kinds = (source) => tokenize(source).map((token) => token.type);
const values = (source) => tokenize(source).map((token) => token.value);

test('tokenizes identifiers, keywords and numbers', () => {
  assert.deepEqual(values('let count = 12'), ['let', 'count', '=', 12, '<eof>']);
  assert.deepEqual(kinds('let count = 12'), [TOKEN.IDENT, TOKEN.IDENT, TOKEN.OP, TOKEN.NUMBER, TOKEN.EOF]);
  const [integer, float, exponent] = tokenize('1 2.5 3e2');
  assert.equal(integer.kind, 'int');
  assert.equal(integer.value, 1);
  assert.equal(float.kind, 'float');
  assert.equal(float.value, 2.5);
  assert.equal(exponent.value, 300);
});

test('tokenizes all documented operators and punctuation', () => {
  const operators = values('= == != > < >= <= + - * / % ! &&');
  assert.deepEqual(operators.slice(0, -1), [
    '=', '==', '!=', '>', '<', '>=', '<=', '+', '-', '*', '/', '%', '!', '&&',
  ]);
  assert.deepEqual(values('{ } ( ) [ ] , ; | >> $(').slice(0, -1), [
    '{', '}', '(', ')', '[', ']', ',', ';', '|', '>>', '$(',
  ]);
});

test('recognises comments and tracks line/column positions', () => {
  const tokens = tokenize('let x = 1 # a comment\n# another\necho x');
  const echo = tokens.find((token) => token.value === 'echo');
  assert.equal(echo.line, 3);
  assert.equal(echo.column, 1);
  const newlineTokens = tokens.filter((token) => token.type === TOKEN.NEWLINE);
  assert.equal(newlineTokens.length, 2);
  assert.equal(newlineTokens[0].line, 1);
  const x = tokens.find((token) => token.value === 'x');
  assert.equal(x.column, 5);
});

test('single-quoted strings are literal', () => {
  const [token] = tokenize("'hello $name ${1 + 2}'");
  assert.equal(token.value, 'hello $name ${1 + 2}');
  assert.deepEqual(token.parts, [{ type: 'text', value: 'hello $name ${1 + 2}' }]);
});

test('double-quoted strings expose variable and expression markers', () => {
  const [token] = tokenize('"hi $name, ${1 + 2}, ${name.upper()}"');
  assert.deepEqual(token.parts.map((part) => part.type), ['text', 'var', 'text', 'expr', 'text', 'expr']);
  assert.equal(token.parts[1].name, 'name');
  assert.equal(token.parts[3].source, '1 + 2');
  assert.equal(token.parts[5].source, 'name.upper()');
});

test('interpolation handles nested quotes and braces', () => {
  const [token] = tokenize('"${json({"a": 1})}"');
  assert.equal(token.parts[0].source, 'json({"a": 1})');
});

test('escapes in strings work as documented', () => {
  const [doubleQuoted] = tokenize('"a\\nb\\t$name\\$"');
  assert.equal(doubleQuoted.parts[0].value, 'a\nb\t');
  assert.equal(doubleQuoted.parts[1].name, 'name');
  assert.equal(doubleQuoted.parts[2].value, '$');
  const [singleQuoted] = tokenize("'it\\'s'");
  assert.equal(singleQuoted.value, "it's");
});

test('clear syntax errors for unterminated strings and bad characters', () => {
  assert.throws(() => tokenize('"unfinished'), (error) => {
    assert.ok(error instanceof LexerError);
    assert.ok(error instanceof SyntaxError);
    assert.match(error.message, /Unterminated string literal \(line 1, column 1\)/);
    return true;
  });
  assert.throws(() => tokenize('line 1\nlet x = @'), (error) => {
    assert.equal(error.line, 2);
    assert.equal(error.column, 9);
    assert.match(error.message, /Unexpected character "@"/);
    return true;
  });
});

test('always terminates with an EOF token', () => {
  assert.equal(tokenize('').length, 1);
  assert.equal(tokenize('')[0].type, TOKEN.EOF);
  assert.equal(tokenize('# only a comment\n')[0].type, TOKEN.NEWLINE);
});
