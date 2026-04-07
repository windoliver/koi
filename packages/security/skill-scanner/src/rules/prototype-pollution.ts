/**
 * Rule: prototype-pollution
 *
 * Detects prototype pollution vectors: recursive merge without __proto__
 * filtering, bracket notation with untrusted keys, for..in without
 * hasOwnProperty guard, and Object.assign with spread of unknown input.
 */

import type { ScanContext, ScanFinding, ScanRule } from "../types.js";
import { getCalleeAsMemberPath, getCalleeName, offsetToLocation, visitAst } from "../walker.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MERGE_FUNCTION_NAMES = new Set([
  "merge",
  "deepMerge",
  "deepExtend",
  "extend",
  "assign",
  "defaults",
  "defaultsDeep",
]);

const PROTO_KEYS = new Set(["__proto__", "constructor", "prototype"]);

// ---------------------------------------------------------------------------
// Rule implementation
// ---------------------------------------------------------------------------

function check(ctx: ScanContext): readonly ScanFinding[] {
  const findings: ScanFinding[] = [];

  // let: set once if any proto key guard is detected in source text
  let hasProtoGuard = false;
  const sourceText = ctx.sourceText;

  // Quick text scan for proto guards — if the code checks for __proto__,
  // it's likely safe (reduces false positives)
  for (const key of PROTO_KEYS) {
    if (sourceText.includes(`"${key}"`) || sourceText.includes(`'${key}'`)) {
      hasProtoGuard = true;
      break;
    }
  }

  visitAst(ctx.program, {
    onCallExpression(node) {
      const callee = getCalleeName(node);

      // Merge-like function calls without proto guards
      if (callee !== undefined && MERGE_FUNCTION_NAMES.has(callee) && !hasProtoGuard) {
        const loc = offsetToLocation(ctx.sourceText, node.start);
        findings.push({
          rule: "prototype-pollution:unsafe-merge",
          severity: "HIGH",
          confidence: 0.7,
          category: "PROTOTYPE_POLLUTION",
          message: `Call to ${callee}() without apparent __proto__/constructor key filtering`,
          location: loc,
        });
      }

      // Object.assign() with spread of unknown input
      const memberPath = getCalleeAsMemberPath(node);
      if (memberPath === "Object.assign" && node.arguments.length >= 2) {
        const secondArg = node.arguments[1];
        // If the second arg is not a literal or known-safe object, flag it
        if (secondArg !== undefined && secondArg.type === "Identifier") {
          const loc = offsetToLocation(ctx.sourceText, node.start);
          findings.push({
            rule: "prototype-pollution:object-assign",
            severity: "MEDIUM",
            confidence: 0.5,
            category: "PROTOTYPE_POLLUTION",
            message:
              "Object.assign() with variable argument — potential prototype pollution if input is untrusted",
            location: loc,
          });
        }
      }
    },

    onAssignmentExpression(node) {
      // Bracket notation assignment with dynamic key: obj[key] = value
      if (node.left.type === "MemberExpression" && node.left.computed) {
        const prop = node.left.property;
        // If the key is a variable (not a string literal or number)
        if (prop.type === "Identifier" && !hasProtoGuard) {
          const loc = offsetToLocation(ctx.sourceText, node.start);
          findings.push({
            rule: "prototype-pollution:bracket-assignment",
            severity: "MEDIUM",
            confidence: 0.6,
            category: "PROTOTYPE_POLLUTION",
            message: `Bracket notation assignment with dynamic key "${prop.name}" without proto key filtering`,
            location: loc,
          });
        }
      }
    },

    onForInStatement(node) {
      // for..in without hasOwnProperty guard (heuristic)
      // Check if body contains hasOwnProperty call
      const bodyText = ctx.sourceText.slice(node.body.start, node.body.end);
      if (!bodyText.includes("hasOwnProperty") && !bodyText.includes("Object.hasOwn")) {
        const loc = offsetToLocation(ctx.sourceText, node.start);
        findings.push({
          rule: "prototype-pollution:for-in-unguarded",
          severity: "MEDIUM",
          confidence: 0.5,
          category: "PROTOTYPE_POLLUTION",
          message:
            "for..in loop without hasOwnProperty/Object.hasOwn guard — may iterate prototype properties",
          location: loc,
        });
      }
    },
  });

  return findings;
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export const prototypePollutionRule: ScanRule = {
  name: "prototype-pollution",
  category: "PROTOTYPE_POLLUTION",
  defaultSeverity: "HIGH",
  check,
};
