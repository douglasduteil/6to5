module.exports = SystemFormatter;

var nodeutil = require('util');
global.d = function () {
  var args = Array.prototype.slice.call(arguments);
  var time = new Date().toISOString();
  console.log(time + ' - ' + nodeutil.inspect.call(null, args.length === 1 ? args[0] : args, false, 3, true));
};

var util = require("../../util");
var t = require("../../types");
var traverse = require('../../traverse');
var _ = require("lodash");

var SETTER_MODULE_NAMESPACE = t.identifier("m");
var PRIVATE_MODULE_NAME_IDENTIFIER = t.identifier("__moduleName");
var DEFAULT_IDENTIFIER = t.identifier("default");
var NULL_SETTER = t.literal(null);

function SystemFormatter(file) {
  this.moduleNameLiteral = null;
  this.exportedStatements = [];
  this.moduleDependencies = {};

  this.exportIdentifier = file.generateUidIdentifier("export");
  this.file = file;

  this._makeExportStatements = _.compose(
    t.expressionStatement,
    // _export(?, ?)
    _.partial(t.callExpression, this.exportIdentifier)
  );
}

SystemFormatter.prototype.import =
  SystemFormatter.prototype.export = function (node, nodes) {
    nodes.push(node);
  };

SystemFormatter.prototype.importSpecifier =
  SystemFormatter.prototype.exportSpecifier = function (specifier, node, nodes) {
    if (!nodes.length) nodes.push(node);
  };

SystemFormatter.prototype.transform = function (ast) {

  // extract the module name
  this.moduleNameLiteral = t.literal(
    this.file.opts.filename.replace(/^.*\//, "").replace(/\..*$/, "")
  );

  // Post extraction of the import/export declaration
  traverse(ast, function (node) {

    _.each([
      SystemFormatter.prototype._extractExportDefault
    ], function(isProcessed){
      // "isProcessed" is not a real boolean here.
      // it's functions that actually process the ast.
      // Those functions return
      // - `true` if they actually change/process the ast,
      // - `false` otherwise.
      return !isProcessed(node);
    });
  });

  this._prependPrivateModuleName(ast);

  this._wrapInSystemRegisterCallExpression(ast);
};


SystemFormatter.prototype._extractExportDefault = function(node){
  if (!t.isExportDeclaration(node)){
    // will continue the conditional looping
    return true;
  }

  d(node.default);
  node = null;

  // will break the conditional looping
  return false;
};

SystemFormatter.prototype._prependPrivateModuleName = function (ast) {
  // generate the __moduleName variable
  var moduleNameVariableNode = t.variableDeclaration("var", [
    t.variableDeclarator(
      PRIVATE_MODULE_NAME_IDENTIFIER,
      this.moduleNameLiteral
    )
  ]);

  ast.program.body.splice(1, 0, moduleNameVariableNode);
};

SystemFormatter.prototype._wrapInSystemRegisterCallExpression = function (ast) {
  var program = ast.program;
  var body = program.body;

  var moduleDependencyNames = Object.keys(this.moduleDependencies)
    .map(t.literal);

  var runner = util.template("register", {
    MODULE_NAME: this.moduleNameLiteral,
    MODULE_DEPENDENCIES: t.arrayExpression(moduleDependencyNames),
    MODULE_BODY: t.functionExpression(
      null,
      [this.exportIdentifier],
      t.blockStatement(body)
    )
  });

  program.body = [t.expressionStatement(runner)];
};
