module.exports = SystemFormatter;

var nodeutil = require('util');
global.d = function() {
  var args = Array.prototype.slice.call(arguments);
  var time = new Date().toISOString();
  console.log(time + ' - ' + nodeutil.inspect.call(null, args.length === 1 ? args[0] : args, false, 3, true));
};

var util = require("../../util");
var t    = require("../../types");
var _    = require("lodash");

var SETTER_MODULE_NAMESPACE = t.identifier("m");
var DEFAULT_IDENTIFIER      = t.identifier("default");
var NULL_SETTER             = t.literal(null);

function SystemFormatter(file) {
  this.exportedStatements = [];
  this.importedModules    = {};

  this.exportIdentifier   = file.generateUidIdentifier("export");
  this.file               = file;

  this._makeExportStatements = _.compose(
    t.expressionStatement,
    // _export(?, ?)
    _.partial(t.callExpression, this.exportIdentifier)
  );
}

SystemFormatter.prototype.transform = function (ast) {
  var program = ast.program;
  var body    = program.body;

  // extract the module name
  var moduleName = this.file.opts.filename
    .replace(/^.*\//, "").replace(/\..*$/, "");

  // build an array of module names
  var dependencies = Object.keys(this.importedModules).map(t.literal);
  var exportedStatements = this.exportedStatements;

  // Go through the final result to extract and replace
  // "VariableDeclarator" with a "_exportedClass" flag
  //
  // May be slow...
  body = _.map(body, function (statement) {

    _(statement.declarations)
      // Filter "VariableDeclarator" with a "_exportedClass" flag
      .filter(function (declaration) {
        return declaration.type === 'VariableDeclarator' &&
          declaration.id && declaration.id._exportedClass;
      })

      .forEach(function (declaration) {

        var assignationRight = declaration.init;

        var targetName = assignationRight && assignationRight.id && assignationRight.id.name ||
          declaration.id && declaration.id.name;

        //  Remove the assignation !
        declaration.init = null;


        var targetStatement = _.find(exportedStatements, {
          _exportedIdentifierName: targetName
        });

        var leftIdentifier = targetStatement.expression.arguments[1];

        if (assignationRight){
          targetStatement.expression.arguments[1] =
            t.assignmentExpression("=", leftIdentifier, assignationRight);
        }

      });

    // This statement might be modified in the above process.
    return statement;
  });

  // generate the __moduleName variable
  var moduleNameVariableNode = t.variableDeclaration("var", [
    t.variableDeclarator(
      t.identifier("__moduleName"),
      t.literal(moduleName)
    )
  ]);
  body.splice(1, 0, moduleNameVariableNode);

  // generate an array of import variables

  var declaredSetters = _(this.importedModules)
    .map()
    .flatten()
    .filter(function (importModule) {
      return !importModule._exportedFrom;
    })
    .pluck("variableName")
    .pluck("name")
    .uniq()
    .map(t.identifier)
    .map(function (name) {
      return t.variableDeclarator(name);
    })
    .value();
  if (declaredSetters.length) {
    body.splice(2, 0, t.variableDeclaration("var", declaredSetters));
  }

  // generate the execute function expression
  var executeFunctionExpression = t.functionExpression(
    null, [], t.blockStatement(this.exportedStatements)
  );

  // generate the execute function expression
  var settersArrayExpression = t.arrayExpression(this._buildSetters());

  // generate the return statement
  var moduleReturnStatement = t.returnStatement(t.objectExpression([
    t.property("init", t.identifier("setters"), settersArrayExpression),
    t.property("init", t.identifier("execute"), executeFunctionExpression)
  ]));
  body.push(moduleReturnStatement);

  // runner
  var runner = util.template("register", {
    MODULE_NAME: t.literal(moduleName),
    MODULE_DEPENDENCIES: t.arrayExpression(dependencies),
    MODULE_BODY: t.functionExpression(
      null,
      [this.exportIdentifier],
      t.blockStatement(body)
    )
  });

  program.body = [t.expressionStatement(runner)];
};

SystemFormatter.prototype._buildSetters = function () {
  // generate setters array expression elements
  return _.map(this.importedModules, function (statements) {
    if (!statements.length) {
      return NULL_SETTER;
    }
    return t.functionExpression(
      null, [SETTER_MODULE_NAMESPACE], t.blockStatement(statements)
    );
  });
};

//
// IMPORTS
//

SystemFormatter.prototype._addImportStatement = function (name, importStatement) {
  this.importedModules[name] = this.importedModules[name] || [];
  importStatement && this.importedModules[name].push(importStatement);
};

SystemFormatter.prototype._addImportAssignmentExpression = function (name, spec) {
  var right = SETTER_MODULE_NAMESPACE;
  if (!spec.isBatch) {
    right = t.memberExpression(right, spec.key);
  }

  this._addImportStatement(name, t.expressionStatement(
    t.assignmentExpression("=", spec.variableName, right)
  ));
};

SystemFormatter.prototype.import = function (node) {
  this._addImportStatement(node.source.value);
};

SystemFormatter.prototype.importSpecifier = function (specifier, node) {
  var variableName = t.getSpecifierName(specifier);

  // import foo from "foo";
  if (specifier.default) {
    specifier.id = DEFAULT_IDENTIFIER;
  }

  this._addImportAssignmentExpression(node.source.value, {
    variableName: variableName,
    isBatch:      specifier.type === "ImportBatchSpecifier",
    key:          specifier.id
  });
};


//
// EXPORTS
//


SystemFormatter.prototype._addToExportStatements = function (name, identifier) {
  _.compose(
    this.exportedStatements.push.bind(this.exportedStatements),

    _.partialRight(
      _.assign, {
        // May be safer to use a file.generateUid here
        _exportedIdentifierName: identifier.name
      }
    ),

    this._makeExportStatements
  )([t.literal(name), identifier]);

};

SystemFormatter.prototype.export = function (node, nodes) {
  var declar = node.declaration;
  var variableName, identifier;

  if (node.default) {
    // export default foo
    variableName = DEFAULT_IDENTIFIER.name;
    if (t.isClass(declar) || t.isFunction(declar)) {
      if (!declar.id) {
        declar.id = this.file.generateUidIdentifier("anonymous");
      }
      declar.id._exportedClass = t.isClass(declar);

      nodes.push(t.toStatement(declar));
      declar = declar.id;
    }

    identifier = declar;
  } else if (t.isVariableDeclaration(declar)) {
    // export var foo
    variableName = declar.declarations[0].id.name;
    identifier = declar.declarations[0].id;
    identifier._exportedClass = true;

    nodes.push(declar);
  } else {
    // export function foo () {}
    variableName = declar.id.name;
    identifier = declar.id;
    identifier._exportedClass = true;

    nodes.push(declar);

    if (t.isFunction(declar)){
      nodes.push(this._makeExportStatements([t.literal(variableName), identifier]));
    }
  }

  this._addToExportStatements(variableName, identifier);
};

/**
 * Generate a export wildcard expression
 * /!\ this is a hack over the existing "exports-wildcard" template
 * @param objectIdentifier
 * @returns the export wildcard expression
 * @private
 */
SystemFormatter.prototype._makeExportWildcard = function (objectIdentifier) {

  var exportStatement = util.template("exports-wildcard", {
    OBJECT: objectIdentifier
  }, true);

  delete exportStatement.expression.callee.expression._scopeReferences;

  var forStatement = exportStatement.expression.callee.expression.body.body[0];
  var iteratorIdentifier = forStatement.left.declarations[0].id;
  var target = t.memberExpression(
    forStatement.right,
    iteratorIdentifier,
    true
  );

  forStatement.body.body = [
    this._makeExportStatements([iteratorIdentifier, target])
  ];

  return exportStatement;
};

SystemFormatter.prototype.exportSpecifier = function (specifier, node) {
  var variableName = t.getSpecifierName(specifier);

  if (node.source) {
    if (t.isExportBatchSpecifier(specifier)) {
      // export * from "foo";
      var exportBatch = this._makeExportWildcard(SETTER_MODULE_NAMESPACE);
      exportBatch._exportedFrom = true;
      this._addImportStatement(node.source.value, exportBatch);

    } else {
      // export { foo } from "test";
      var target = t.memberExpression(
        SETTER_MODULE_NAMESPACE,
        specifier.id
      );

      var exportSelection = this._makeExportStatements([
        t.literal(variableName.name), target
      ]);
      exportSelection._exportedFrom = true;
      this._addImportStatement(node.source.value, exportSelection);

    }
  } else {
    // export { foo };
    this._addToExportStatements(variableName.name, specifier.id);
  }
};
