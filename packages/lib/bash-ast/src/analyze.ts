/**
 * @koi/bash-ast — pure AST analysis.
 *
 * Runs the parser and the allowlist walker against a raw command string and
 * returns an `AstAnalysis`. This function is pure with respect to its input
 * (no I/O, no side effects besides reading the cached parser from init.ts)
 * and owns no prefilter logic — that lives in `classify.ts` alongside the
 * transitional regex fallback.
 *
 * Pipeline:
 *
 *   1. Length guard   — over-length input → parse-unavailable
 *   2. Parser ready?  — fail closed if init hasn't completed
 *   3. Parse          — timeout / panic → parse-unavailable
 *   4. Walk           — extracts SimpleCommand[] or returns too-complex
 *
 * The fail-closed invariant (covered by the fail-closed test suite): steps
 * 2 and 3 MUST NEVER fall through to a permissive path — every failure
 * produces `parse-unavailable` with the correct `cause` discriminator.
 */

import { getParser } from "./init.js";
import type { AstAnalysis } from "./types.js";
import { walkProgram } from "./walker.js";

/** Hard cap on input length. Matches CC's MAX_COMMAND_LENGTH. */
export const MAX_COMMAND_LENGTH = 10_000;

/**
 * Per-parse deadline in milliseconds. Enforced via `progressCallback`. Matches
 * CC's 50 ms budget for pathological inputs like deeply-nested arithmetic
 * expansions `(( a[0][0]...))` or adversarial brace grammars.
 */
const PARSE_DEADLINE_MS = 50;

/**
 * Analyze a raw bash command string. Sync hot path.
 *
 * Callers MUST treat `parse-unavailable` as deny (fail closed). `too-complex`
 * is NOT a failure — it's a signal to route to a fallback policy.
 */
export function analyzeBashCommand(command: string): AstAnalysis {
  if (command.length > MAX_COMMAND_LENGTH) {
    return { kind: "parse-unavailable", cause: "over-length" };
  }

  const parser = getParser();
  if (parser === null) {
    return { kind: "parse-unavailable", cause: "not-initialized" };
  }

  const deadline = performance.now() + PARSE_DEADLINE_MS;
  let tree: ReturnType<typeof parser.parse>;
  try {
    tree = parser.parse(command, null, {
      // Returning a truthy value cancels the in-flight parse. The .d.ts
      // types the return as `void`, but the runtime checks for truthiness
      // (see `_tree_sitter_progress_callback` in web-tree-sitter.js).
      // `void`-typed functions accept any return value in TS, so this is
      // fine without casts.
      progressCallback: () => {
        if (performance.now() > deadline) return true;
      },
    });
  } catch {
    return { kind: "parse-unavailable", cause: "panic" };
  }
  if (tree === null) {
    // web-tree-sitter returns null when the parse is cancelled (deadline
    // exceeded via progressCallback) or when the internal parser rejects
    // the input. Fail closed either way.
    return { kind: "parse-unavailable", cause: "timeout" };
  }

  const walkResult = walkProgram(tree.rootNode);
  if (walkResult.kind === "too-complex") {
    return walkResult.nodeType !== undefined
      ? {
          kind: "too-complex",
          reason: walkResult.reason,
          nodeType: walkResult.nodeType,
        }
      : { kind: "too-complex", reason: walkResult.reason };
  }

  return { kind: "simple", commands: walkResult.commands };
}
