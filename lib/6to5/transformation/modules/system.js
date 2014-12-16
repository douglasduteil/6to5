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

  var systemTransform = this;

  // extract the module name
  this.moduleNameLiteral = t.literal(
    this.file.opts.filename.replace(/^.*\//, "").replace(/\..*$/, "")
  );

  // Post extraction of the import/export declaration
  traverse(ast, function (node) {
    var isNodeToRemove = _.any([
      SystemFormatter.prototype._extractExportDefault,
      SystemFormatter.prototype._extractExportVariableDeclaration,
      SystemFormatter.prototype._extractExportFunctionDeclaration,
      SystemFormatter.prototype._extractExportSpecifiers
    ], function (isProcessed) {
      // "isProcessed" is not a real boolean here.
      // it's a function that actually processes the node
      // and returns
      // - `true` if it actually changes/processes the node,
      // - `false` otherwise.
      return isProcessed.call(systemTransform, node);
    });

    return isNodeToRemove ? [] : null;
  });

  this._prependPrivateModuleName(ast);
  this._appendModuleReturnStatemnt(ast);
  this._wrapInSystemRegisterCallExpression(ast);
};

//
// Import/Export extraction
//


SystemFormatter.prototype._extractExportDefault = function (node) {
  if (!(t.isExportDeclaration(node) && node.default)) {
    return false;
  }

  // An "export default foo" here
  d('An "export default foo" here')

  return true;
};

SystemFormatter.prototype._extractExportVariableDeclaration = function (node) {
  var declar = node.declaration;

  if (!(t.isExportDeclaration(node) && t.isVariableDeclaration(declar))) {
    return false;
  }

  // An "export var foo" here
  d('An "export var foo" here')

  return true;
};

SystemFormatter.prototype._extractExportFunctionDeclaration = function (node) {
  var declar = node.declaration;

  if (!(t.isExportDeclaration(node) && t.isFunctionDeclaration(declar))) {
    return false;
  }

  // An "export function foo () {}" here
  d('An "export function foo () {}" here')

  return true;
};

SystemFormatter.prototype._extractExportSpecifiers = function (node) {
  var systemTransform = this;

  if (!( t.isExportDeclaration(node) && node.specifiers )) {
    return false;
  }

  _.each(node.specifiers, function (specifier) {
    // Run each, break when one is true.
    _.any([
      SystemFormatter.prototype._extractExportBatch,
      SystemFormatter.prototype._extractExportFrom,
      SystemFormatter.prototype._extractExportNamed
    ], function (extractor) {
      return extractor.call(systemTransform, specifier, node);
    });
  });

  return true;
};

SystemFormatter.prototype._extractExportBatch = function (specifier, node) {

  if (!(node.source && t.isExportBatchSpecifier(specifier))) {
    return false;
  }

  // An "export * from "foo"" here
  d('An "export * from "foo"" here')

  return true;
};

SystemFormatter.prototype._extractExportFrom = function (specifier, node) {

  // Weak test here...
  if (!(node.source)) {
    return false;
  }

  // An "export { foo } from "test"" here
  d('An "export { foo } from "test"" here')

  return true;
};

SystemFormatter.prototype._extractExportNamed = function (specifier, node) {

  // Last case...
  // Dunno what to test here...

  // An "export { foo }" here
  d('An "export { foo }" here')

  return true;

};

//
// Additional body content
//

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

SystemFormatter.prototype._buildSetters = function () {
  // generate setters array expression elements
  return _.map(this.moduleDependencies, function (specs) {
    if (!specs.length) {
      return NULL_SETTER;
    }

    var expressionStatements = _.map(specs, function (spec) {
      var right = SETTER_MODULE_NAMESPACE;
      if (!spec.isBatch) {
        right = t.memberExpression(right, spec.key);
      }

      return t.expressionStatement(
        t.assignmentExpression("=", spec.variableName, right)
      );
    });

    return t.functionExpression(
      null, [SETTER_MODULE_NAMESPACE], t.blockStatement(expressionStatements)
    );
  });
};

SystemFormatter.prototype._appendModuleReturnStatemnt = function (ast) {

  // generate the execute function expression
  var executeFunctionExpression = t.functionExpression(
    null, [], t.blockStatement(this.exportedStatements)
  );

  // generate the execute function expression
  var settersArrayExpression = t.arrayExpression(this._buildSetters());

  var moduleReturnStatement = t.returnStatement(t.objectExpression([
    t.property("init", t.identifier("setters"), settersArrayExpression),
    t.property("init", t.identifier("execute"), executeFunctionExpression)
  ]));

  ast.program.body.push(moduleReturnStatement);
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
