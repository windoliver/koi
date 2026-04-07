/**
 * Rule: filesystem-abuse
 *
 * Detects dangerous filesystem operations: deletion (rm, unlink, rmdir),
 * arbitrary writes (writeFile, appendFile, createWriteStream),
 * renames, and dynamic fs module imports.
 */

import type { ScanContext, ScanFinding, ScanRule } from "../types.js";
import {
  getCalleeAsMemberPath,
  getCalleeName,
  getStringValue,
  offsetToLocation,
  visitAst,
} from "../walker.js";

// ---------------------------------------------------------------------------
// Constants — member-access calls (fs.unlinkSync, etc.)
// ---------------------------------------------------------------------------

const DANGEROUS_FS_DELETE_CALLS = new Set([
  "fs.unlinkSync",
  "fs.unlink",
  "fs.rmdirSync",
  "fs.rmdir",
  "fs.rmSync",
  "fs.rm",
]);

const DANGEROUS_FS_WRITE_CALLS = new Set([
  "fs.writeFileSync",
  "fs.writeFile",
  "fs.appendFile",
  "fs.appendFileSync",
  "fs.createWriteStream",
]);

const DANGEROUS_FS_RENAME_CALLS = new Set(["fs.renameSync", "fs.rename"]);

// ---------------------------------------------------------------------------
// Constants — destructured calls (unlinkSync, writeFileSync, etc.)
// ---------------------------------------------------------------------------

const DESTRUCTURED_DELETE = new Set(["unlinkSync", "unlink", "rmdirSync", "rmdir", "rmSync", "rm"]);

const DESTRUCTURED_WRITE = new Set([
  "writeFileSync",
  "writeFile",
  "appendFile",
  "appendFileSync",
  "createWriteStream",
]);

const DESTRUCTURED_RENAME = new Set(["renameSync", "rename"]);

// ---------------------------------------------------------------------------
// Rule implementation
// ---------------------------------------------------------------------------

function check(ctx: ScanContext): readonly ScanFinding[] {
  const findings: ScanFinding[] = [];

  visitAst(ctx.program, {
    onCallExpression(node) {
      // --- Member-access calls: fs.rmSync(...), fs.writeFileSync(...) ---
      const memberPath = getCalleeAsMemberPath(node);
      if (memberPath !== undefined) {
        if (DANGEROUS_FS_DELETE_CALLS.has(memberPath)) {
          const loc = offsetToLocation(ctx.sourceText, node.start);
          findings.push({
            rule: "filesystem-abuse:delete",
            severity: "CRITICAL",
            confidence: 0.9,
            category: "FILESYSTEM_ABUSE",
            message: `${memberPath}() — filesystem deletion`,
            location: loc,
          });
          return;
        }

        if (DANGEROUS_FS_WRITE_CALLS.has(memberPath)) {
          const loc = offsetToLocation(ctx.sourceText, node.start);
          findings.push({
            rule: "filesystem-abuse:write",
            severity: "HIGH",
            confidence: 0.85,
            category: "FILESYSTEM_ABUSE",
            message: `${memberPath}() — arbitrary filesystem write`,
            location: loc,
          });
          return;
        }

        if (DANGEROUS_FS_RENAME_CALLS.has(memberPath)) {
          const loc = offsetToLocation(ctx.sourceText, node.start);
          findings.push({
            rule: "filesystem-abuse:rename",
            severity: "MEDIUM",
            confidence: 0.6,
            category: "FILESYSTEM_ABUSE",
            message: `${memberPath}() — filesystem rename`,
            location: loc,
          });
          return;
        }
      }

      // --- Destructured calls: rmSync(...), writeFileSync(...) ---
      const callee = getCalleeName(node);
      if (callee !== undefined) {
        if (DESTRUCTURED_DELETE.has(callee)) {
          const loc = offsetToLocation(ctx.sourceText, node.start);
          findings.push({
            rule: "filesystem-abuse:delete",
            severity: "HIGH",
            confidence: 0.7,
            category: "FILESYSTEM_ABUSE",
            message: `${callee}() — potential filesystem deletion (destructured import)`,
            location: loc,
          });
          return;
        }

        if (DESTRUCTURED_WRITE.has(callee)) {
          const loc = offsetToLocation(ctx.sourceText, node.start);
          findings.push({
            rule: "filesystem-abuse:write",
            severity: "MEDIUM",
            confidence: 0.6,
            category: "FILESYSTEM_ABUSE",
            message: `${callee}() — potential filesystem write (destructured import)`,
            location: loc,
          });
          return;
        }

        if (DESTRUCTURED_RENAME.has(callee)) {
          const loc = offsetToLocation(ctx.sourceText, node.start);
          findings.push({
            rule: "filesystem-abuse:rename",
            severity: "LOW",
            confidence: 0.5,
            category: "FILESYSTEM_ABUSE",
            message: `${callee}() — potential filesystem rename (destructured import)`,
            location: loc,
          });
          return;
        }
      }
    },

    onImportExpression(node) {
      // Dynamic import("fs") or import("fs/promises")
      const source = getStringValue(node.source);
      if (
        source === "fs" ||
        source === "fs/promises" ||
        source === "node:fs" ||
        source === "node:fs/promises"
      ) {
        const loc = offsetToLocation(ctx.sourceText, node.start);
        findings.push({
          rule: "filesystem-abuse:fs-import",
          severity: "LOW",
          confidence: 0.4,
          category: "FILESYSTEM_ABUSE",
          message: `Dynamic import("${source}") — filesystem module access`,
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

export const filesystemAbuseRule: ScanRule = {
  name: "filesystem-abuse",
  category: "FILESYSTEM_ABUSE",
  defaultSeverity: "HIGH",
  check,
};
