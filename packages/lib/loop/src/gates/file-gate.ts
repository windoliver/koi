/**
 * createFileGate — verifies a file exists and optionally matches a pattern.
 *
 * Ported from v1 verified-loop with three changes:
 *   1. Typed failure reasons (file_missing vs file_no_match) instead of a
 *      free-form details-only variant.
 *   2. Reads via Bun.file so it benefits from Bun's streaming fast path.
 *   3. Relative paths are resolved against VerifierContext.workingDir, not
 *      process.cwd(). RunUntilPassConfig makes workingDir mandatory precisely
 *      to prevent verifiers from silently running against the wrong
 *      directory — the file gate has to honor the same invariant.
 *
 * Retry-safety note: RegExp.prototype.test() mutates lastIndex for /g and
 * /y flags, so reusing the caller's regex instance across iterations can
 * make the same unchanged file pass once and then fail on the next check.
 * We clone any RegExp argument at construction time and strip stateful
 * flags to keep .test() deterministic across the loop's retry path.
 */

import { isAbsolute, resolve } from "node:path";
import type { Verifier, VerifierResult } from "../types.js";

export function createFileGate(path: string, match: string | RegExp): Verifier {
  // If the caller passed a RegExp with /g or /y flags, .test() would mutate
  // lastIndex on every call and the same file could flip from pass to fail
  // between iterations. Clone the source and drop stateful flags so every
  // invocation is independent. Non-regex matches are strings and already
  // stateless.
  const stableMatch: string | RegExp =
    typeof match === "string"
      ? match
      : new RegExp(match.source, match.flags.replace("g", "").replace("y", ""));

  return {
    async check(ctx): Promise<VerifierResult> {
      // Relative paths resolve against the loop's workingDir, never cwd.
      // Absolute paths are honored as-is so callers can still point at
      // /tmp/foo or similar when that's the right behavior.
      const resolvedPath = isAbsolute(path) ? path : resolve(ctx.workingDir, path);
      const file = Bun.file(resolvedPath);
      const exists = await file.exists();
      if (!exists) {
        return {
          ok: false,
          reason: "file_missing",
          details: `file not found: ${resolvedPath}`,
        };
      }
      let content: string;
      try {
        content = await file.text();
      } catch (err) {
        return {
          ok: false,
          reason: "file_missing",
          details: `failed to read ${resolvedPath}: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
      const matched =
        typeof stableMatch === "string" ? content.includes(stableMatch) : stableMatch.test(content);
      if (matched) {
        return { ok: true, details: `matched ${resolvedPath}` };
      }
      return {
        ok: false,
        reason: "file_no_match",
        details: `no match for ${stableMatch.toString()} in ${resolvedPath}`,
      };
    },
  };
}
