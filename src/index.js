'use strict';

/**
 * Public API for embedding SwiftShell in other Node programs.
 *
 *   const { parse, Interpreter } = require('swift-shell');
 *   const result = new Interpreter().run(parse('echo "hello"'));
 */

const { tokenize, TOKEN, LexerError } = require('./lexer');
const { Parser, ParserError, parse, parseTokens, parseExpression } = require('./parser');
const {
  Interpreter, Environment, FunctionValue, BuiltinValue, RuntimeError, truthy, valuesEqual,
} = require('./interpreter');
const { builtins, VERSION, evaluateMath, ExitRequest, BuiltinError } = require('./builtins');
const { PackageManager, PackageError, DEFAULT_HOME } = require('./packages');
const swiftfetch = require('./swiftfetch');
const cli = require('./cli');

module.exports = {
  VERSION,
  tokenize,
  TOKEN,
  LexerError,
  Parser,
  ParserError,
  parse,
  parseTokens,
  parseExpression,
  Interpreter,
  Environment,
  FunctionValue,
  BuiltinValue,
  RuntimeError,
  truthy,
  valuesEqual,
  builtins,
  evaluateMath,
  ExitRequest,
  BuiltinError,
  PackageManager,
  PackageError,
  DEFAULT_HOME,
  swiftfetch,
  cli,
};
