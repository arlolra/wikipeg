"use strict";

var visitor        = require("../visitor"),
    asts           = require("../asts"),
    GrammarError   = require("../../grammar-error"),
    objects        = require("../../utils/objects"),
    Traverser      = require("../traverser");

function analyzeParams(ast, options) {
  var paramInfos = {};
  var boolIndex = 0;
  var refScopeIndex = 0;

  function registerParamType(name, type, location) {
    var paramInfo = getParamInfo(name);
    if (paramInfo.type !== undefined) {
      if (paramInfo.type !== type) {
        throw new GrammarError("Type conflict in parameter " + name, location);
      }
    } else {
      paramInfo.type = type;
      if (type === 'boolean') {
        if (boolIndex > 31) {
          throw new GrammarError("A maximum of 32 boolean parameters may be defined", location);
        }
        paramInfo.index = boolIndex++;
      }
    }
  }

  function getParamInfo(name) {
    if (paramInfos[name] === undefined) {
      paramInfos[name] = {name: name};
    }
    return paramInfos[name];
  }

  function newRefScope() {
    return {
      id: refScopeIndex++,
      capture: false
    };
  }

  let startRules = options.allowedStartRules.concat(options.allowedStreamRules);

  function isStartRule(ruleName) {
    return startRules.indexOf(ruleName) !== -1
  }

  function hasRefAssignment(ruleRefNode) {
    for (let i = 0; i < ruleRefNode.assignments.length; i++) {
      let assignment = ruleRefNode.assignments[i];
      if (assignment.isref) {
        return true;
      }
    }
    return false;
  }

  let allRefParams = {};

  // Handlers for a call graph traverser which will mark touched nodes as
  // having a particular parameter previously assigned. Also, if the parameter
  // is a reference parameter, record any captures in the given scope object,
  // unless there has been an assignment to that reference earlier in the call
  // graph.
  let assignmentHandlers = {
    rule: function(node, isAssigned, paramName, refScope) {
      if (isAssigned) {
        if (node.assignedParams === undefined) {
          node.assignedParams = {};
        }
        node.assignedParams[paramName] = true;
      }
      if (node.refScopeSets === undefined) {
        node.refScopeSets = {};
      }
      if (node.refScopeSets[paramName] === undefined) {
        node.refScopeSets[paramName] = new Set();
      }
      node.refScopeSets[paramName].add(refScope);
      this.traverse(node.expression, isAssigned, paramName, refScope);
    },

    rule_ref: function(node, isAssigned, paramName, refScope) {
      if (refScope) {
        for (let i = 0; i < node.assignments.length; i++) {
          let assignment = node.assignments[i];
          if (assignment.isref && assignment.name === paramName) {
            refScope = null;
          }
        }
      }

      this.traverse(asts.findRule(ast, node.name), isAssigned, paramName, refScope);
    },

    labeled_param: function(node, isAssigned, paramName, refScope) {
      if (node.isref && refScope && node.parameter === paramName) {
        refScope.capture = true;
      }
    }
  };

  // For each parameter assignment, traverse the call graph, notifying called
  // nodes that the parameter has been assigned. Also collect type information.
  visitor.build({
    rule_ref: function(node) {
      let targetNode = asts.findRule(ast, node.name);

      for (let i = 0; i < node.assignments.length; i++) {
        let assignment = node.assignments[i];
        let type;

        if (assignment.isref) {
          type = 'reference';
        } else if (assignment.type === 'increment') {
          type = 'integer';
        } else {
          type = assignment.type;
        }
        registerParamType(assignment.name, type, node.location);
        assignment.paramInfo = getParamInfo(assignment.name);

        let refScope = null;
        if (assignment.isref) {
          refScope = newRefScope();
          allRefParams[assignment.name] = true;
        }

        (new Traverser(ast, assignmentHandlers))
          .traverse(targetNode, true, assignment.name, refScope);
      }
    }
  })(ast);

  // For every reference parameter, traverse the call graph of each start rule,
  // collecting scope capture information
  for (let paramName in allRefParams) {
    startRules.forEach(function(ruleName) {
      let node = asts.findRule(ast, ruleName);
      let refScope = newRefScope();
      (new Traverser(ast, assignmentHandlers))
        .traverse(node, false, paramName, refScope);
    });
  }

  // Traverse the call graph for every rule, accumulating lists of
  // accessed parameters
  let accessTraverser = new Traverser(ast, {
    rule_ref: function(node, accessedParams) {
      let ruleNode = asts.findRule(ast, node.name);
      if (ruleNode.accessedParams === undefined) {
        this.traverse(ruleNode, {});
      }
      let newAccessedParams = {};
      Object.assign(newAccessedParams, ruleNode.accessedParams);

      for (let i = 0; i < node.assignments.length; i++) {
        let assignment = node.assignments[i];

        // Params which are assigned (except increment) have their previous
        // values discarded, so we don't need to know what the previous value
        // was.
        if (assignment.name in newAccessedParams && assignment.type !== 'increment') {
          delete newAccessedParams[assignment.name];
        }
      }

      Object.assign(accessedParams, newAccessedParams);
    },

    rule: function(node, accessedParams) {
      this.traverse(node.expression, accessedParams)
      node.accessedParams = accessedParams;
    },

    parameter_and: function(node, accessedParams) {
      node.paramInfo = accessedParams[node.parameter] = getParamInfo(node.parameter);
    },

    parameter_not: function(node, accessedParams) {
      node.paramInfo = accessedParams[node.parameter] = getParamInfo(node.parameter);
    },

    labeled_param: function(node, accessedParams) {
      node.paramInfo = accessedParams[node.parameter] = getParamInfo(node.parameter);
    }
  });

  visitor.build({
    rule: function(node) {
      accessTraverser.traverse(node, {});
    }
  })(ast);

  // A parameter needs to be passed to the rule function if the parameter was
  // both written to and accessed. If the parameter was only accessed but
  // statically not written, we can generate a literal for it. Capturing a
  // reference parameter for possible modification by JS counts as a write
  // and affects everything in the reference scope.

  // Generate convenience properties on the rules reflecting this situation.
  ast.rules.forEach(function(node) {
    node.passedParams = {};
    node.hasBoolParams = false;

    for (let paramName in node.accessedParams) {
      let paramInfo = node.accessedParams[paramName]

      let assigned = false;
      if (node.assignedParams && node.assignedParams[paramName]) {
        assigned = true;
      } else if (node.refScopeSets && node.refScopeSets[paramName]) {
        node.refScopeSets[paramName].forEach(function (scope) {
          if (scope.capture) {
            assigned = true;
          }
        });
      }
      if (assigned) {
        if (paramInfo.type === 'boolean') {
          node.hasBoolParams = true;
        }
        node.passedParams[paramName] = paramInfo;
      }
    }

    // This is bulky and no longer needed
    delete node.refScopeSets;
  }); 
}

module.exports = analyzeParams;
