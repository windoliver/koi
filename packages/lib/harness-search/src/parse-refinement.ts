/**
 * Code-block extraction for refinement outputs.
 *
 * Refiners that emit explanation + example + final code, or stream a
 * diff next to a snippet, can produce multiple fenced blocks. Picking
 * the first fence blindly evaluates the wrong artifact and burns
 * search budget on stale/example code; picking the last fence is also
 * fragile because a trailing example would silently win.
 *
 * Strategy: accept exactly ONE fence, OR accept multi-block output
 * only when exactly one fence carries an explicit source-language tag
 * (`typescript`, `ts`, `javascript`, `js`). Anything else returns
 * `null` so the caller surfaces `refine_failed` rather than evaluating
 * an arbitrary block.
 *
 * Structural / schema checks remain the verifier's job
 * (forge-verifier), invoked downstream of search.
 */

// Match every fenced block in the output.
//
// Group 1: the language token (leading run of ASCII letters; may be
//   empty). Standard markdown info strings allow trailing content
//   after the language tag — e.g. ```ts title="candidate.ts" or
//   ```typescript app.ts. Anything between the language token and the
//   first newline is consumed but ignored, so common LLM formatting
//   drift doesn't reject an otherwise-valid block.
// Group 2: the body.
//
// The closing fence must appear at the START of a line (preceded by
// `\n` or matching the very first newline after the body), so
// triple-backticks embedded inside string / template literals in the
// body don't truncate a valid candidate at the wrong place.
const CODE_FENCE_GLOBAL = /```([a-zA-Z]*)[^\n]*\n([\s\S]*?)\n```(?:$|\n|\r)/g;

// Tags that count as "the canonical code block" in multi-block output.
// Both TS and JS are accepted: refiners targeting JS-only tooling
// commonly return one example block plus a final js/javascript block,
// and rejecting that as ambiguous would force a refine_failed exit on a
// perfectly valid response.
const CANONICAL_TAGS: ReadonlySet<string> = new Set(["typescript", "ts", "javascript", "js"]);
// Source-language tags accepted as candidate code on the single-block
// happy path. Untagged ("") fences are also accepted because adapters
// commonly emit bare ``` for the only output. Tags like `json`,
// `diff`, `bash`, `text`, `md`, etc. are NOT in this set — they signal
// the refiner emitted something other than tool source, and should
// surface as refine_failed at the trust boundary instead of being
// evaluated as code.
const SOURCE_TAGS: ReadonlySet<string> = new Set(["", "typescript", "ts", "javascript", "js"]);

/**
 * Extract the canonical fenced code block from refinement output.
 * Returns null when:
 *   - the input is not a string;
 *   - there is no block, or the only block is empty;
 *   - the only block carries a non-source tag (json, diff, bash, ...);
 *   - the output is multi-block AND there is no single unambiguous
 *     typescript-tagged block among them.
 * Accepts `unknown` so a refiner that accidentally resolves structured
 * output / null / undefined degrades to `refine_failed` instead of
 * throwing.
 */
export function parseRefinementOutput(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const blocks: { readonly tag: string; readonly body: string }[] = [];
  for (const match of raw.matchAll(CODE_FENCE_GLOBAL)) {
    const tag = (match[1] ?? "").toLowerCase();
    const body = match[2]?.trim() ?? "";
    if (body.length > 0) blocks.push({ tag, body });
  }

  if (blocks.length === 0) return null;
  if (blocks.length === 1) {
    const only = blocks[0];
    if (only === undefined) return null;
    // Single-block path: accept untagged or recognized source language.
    // Reject `json` / `diff` / `bash` / etc. — they signal refiner drift.
    return SOURCE_TAGS.has(only.tag) ? only.body : null;
  }

  // Multi-block output: accept only when exactly one block carries an
  // explicit source-language tag (ts/typescript/js/javascript). Untagged
  // blocks deliberately don't count here — they're usually examples or
  // shell snippets, and treating them as candidates would silently win
  // when the model emitted a tagged final block alongside.
  const canonical = blocks.filter((b) => CANONICAL_TAGS.has(b.tag));
  if (canonical.length === 1) return canonical[0]?.body ?? null;
  return null;
}
