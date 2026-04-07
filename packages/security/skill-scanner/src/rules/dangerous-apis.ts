/**
 * Rule: dangerous-apis
 *
 * Detects direct calls to dangerous APIs: eval, Function, child_process,
 * vm, dynamic require/import, and variable aliases to these APIs.
 */

import type { ScanContext, ScanFinding, ScanRule } from "../types.js";
import {
  buildScopeTracker,
  getCalleeAsMemberPath,
  getCalleeName,
  getStringValue,
  offsetToLocation,
  visitAst,
} from "../walker.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DANGEROUS_GLOBALS = new Set(["eval", "Function"]);

const DANGEROUS_TIMER_APIS = new Set(["setTimeout", "setInterval"]);

const DANGEROUS_MODULES = new Set(["child_process", "cluster", "dgram", "net", "tls", "vm"]);

/** Strip `node:` prefix so both `"child_process"` and `"node:child_process"` match. */
function normalizeModuleId(specifier: string): string {
  return specifier.startsWith("node:") ? specifier.slice(5) : specifier;
}

const GLOBAL_EVAL_PATHS = new Set(["globalThis.eval", "window.eval", "global.eval"]);

const DANGEROUS_MEMBER_CALLS = new Set([
  "process.binding",
  "process._linkedBinding",
  "vm.runInContext",
  "vm.runInNewContext",
  "vm.runInThisContext",
  "child_process.exec",
  "child_process.execSync",
  "child_process.spawn",
  "child_process.spawnSync",
  "child_process.execFile",
  "child_process.execFileSync",
  "child_process.fork",
]);

// ---------------------------------------------------------------------------
// Rule implementation
// ---------------------------------------------------------------------------

function check(ctx: ScanContext): readonly ScanFinding[] {
  const findings: ScanFinding[] = [];
  const scope = buildScopeTracker(ctx.program);

  visitAst(ctx.program, {
    onCallExpression(node) {
      // Direct dangerous global calls: eval(), Function()
      const callee = getCalleeName(node);
      if (callee !== undefined) {
        const resolved = scope.resolve(callee);

        if (DANGEROUS_GLOBALS.has(resolved)) {
          const loc = offsetToLocation(ctx.sourceText, node.start);
          const isAlias = resolved !== callee;
          findings.push({
            rule: `dangerous-api:${resolved}`,
            severity: "CRITICAL",
            confidence: isAlias ? 0.8 : 0.95,
            category: "DANGEROUS_API",
            message: isAlias
              ? `Aliased call to ${resolved}() via variable "${callee}"`
              : `Direct call to ${resolved}()`,
            location: loc,
          });
        }

        // setTimeout/setInterval with string argument
        if (DANGEROUS_TIMER_APIS.has(resolved) && node.arguments.length > 0) {
          const firstArg = node.arguments[0];
          if (firstArg !== undefined && getStringValue(firstArg) !== undefined) {
            const loc = offsetToLocation(ctx.sourceText, node.start);
            findings.push({
              rule: `dangerous-api:${resolved}-string`,
              severity: "HIGH",
              confidence: 0.9,
              category: "DANGEROUS_API",
              message: `${resolved}() called with string argument (implicit eval)`,
              location: loc,
            });
          }
        }

        // Dynamic require: require(variable)
        if (resolved === "require" && node.arguments.length > 0) {
          const firstArg = node.arguments[0];
          if (firstArg !== undefined) {
            const strVal = getStringValue(firstArg);
            if (strVal !== undefined && DANGEROUS_MODULES.has(normalizeModuleId(strVal))) {
              const loc = offsetToLocation(ctx.sourceText, node.start);
              findings.push({
                rule: "dangerous-api:require-dangerous-module",
                severity: "CRITICAL",
                confidence: 0.9,
                category: "DANGEROUS_API",
                message: `require("${strVal}") — dangerous module access`,
                location: loc,
              });
            } else if (strVal === undefined) {
              const loc = offsetToLocation(ctx.sourceText, node.start);
              findings.push({
                rule: "dangerous-api:dynamic-require",
                severity: "HIGH",
                confidence: 0.7,
                category: "DANGEROUS_API",
                message: "Dynamic require() with non-literal argument",
                location: loc,
              });
            }
          }
        }
      }

      // Member expression calls: child_process.exec(), process.binding()
      const memberPath = getCalleeAsMemberPath(node);
      if (memberPath !== undefined) {
        if (DANGEROUS_MEMBER_CALLS.has(memberPath)) {
          const loc = offsetToLocation(ctx.sourceText, node.start);
          findings.push({
            rule: `dangerous-api:${memberPath}`,
            severity: "CRITICAL",
            confidence: 0.9,
            category: "DANGEROUS_API",
            message: `Call to dangerous API: ${memberPath}()`,
            location: loc,
          });
        }

        // globalThis.eval(), window.eval(), global.eval()
        if (GLOBAL_EVAL_PATHS.has(memberPath)) {
          const loc = offsetToLocation(ctx.sourceText, node.start);
          findings.push({
            rule: "dangerous-api:global-eval",
            severity: "CRITICAL",
            confidence: 0.95,
            category: "DANGEROUS_API",
            message: `Call to ${memberPath}() — global eval access`,
            location: loc,
          });
        }
      }
    },

    onNewExpression(node) {
      // new Function(...)
      if (node.callee.type === "Identifier") {
        const resolved = scope.resolve(node.callee.name);
        if (resolved === "Function") {
          const loc = offsetToLocation(ctx.sourceText, node.start);
          findings.push({
            rule: "dangerous-api:new-Function",
            severity: "CRITICAL",
            confidence: 0.95,
            category: "DANGEROUS_API",
            message: "new Function() constructor — equivalent to eval",
            location: loc,
          });
        }
      }
    },

    onImportExpression(node) {
      // Dynamic import with non-literal source
      const strVal = getStringValue(node.source);
      if (strVal !== undefined && DANGEROUS_MODULES.has(normalizeModuleId(strVal))) {
        const loc = offsetToLocation(ctx.sourceText, node.start);
        findings.push({
          rule: "dangerous-api:import-dangerous-module",
          severity: "CRITICAL",
          confidence: 0.9,
          category: "DANGEROUS_API",
          message: `Dynamic import of dangerous module: "${strVal}"`,
          location: loc,
        });
      } else if (strVal === undefined) {
        const loc = offsetToLocation(ctx.sourceText, node.start);
        findings.push({
          rule: "dangerous-api:dynamic-import",
          severity: "HIGH",
          confidence: 0.7,
          category: "DANGEROUS_API",
          message: "Dynamic import() with non-literal source",
          location: loc,
        });
      }
    },

    onImportDeclaration(node) {
      // Static import: `import { execSync } from "node:child_process"`
      // Flag regardless of which specifiers are imported — the module access itself is dangerous.
      const strVal = node.source.value;
      if (DANGEROUS_MODULES.has(normalizeModuleId(strVal))) {
        const loc = offsetToLocation(ctx.sourceText, node.start);
        findings.push({
          rule: "dangerous-api:static-import-dangerous-module",
          severity: "CRITICAL",
          confidence: 0.95,
          category: "DANGEROUS_API",
          message: `Static import of dangerous module: "${strVal}"`,
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

export const dangerousApisRule: ScanRule = {
  name: "dangerous-apis",
  category: "DANGEROUS_API",
  defaultSeverity: "CRITICAL",
  check,
};
