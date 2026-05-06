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
 * only when exactly one fence carries an explicit `typescript`/`ts`
 * tag (the convention adapters should emit). Anything else returns
 * `null` so the caller surfaces `refine_failed` rather than evaluating
 * an arbitrary block.
 *
 * Structural / schema checks remain the verifier's job
 * (forge-verifier), invoked downstream of search.
 */

// Match every fenced block in the output. Capture group 1 is the
// language tag (may be empty), group 2 the body.
const CODE_FENCE_GLOBAL = /```([a-zA-Z]*)\s*\n([\s\S]*?)```/g;

const TS_TAGS: ReadonlySet<string> = new Set(["typescript", "ts"]);
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

  // Multi-block output: accept only when exactly one block is tagged
  // typescript/ts. Otherwise refuse to guess which one is the answer.
  const tsBlocks = blocks.filter((b) => TS_TAGS.has(b.tag));
  if (tsBlocks.length === 1) return tsBlocks[0]?.body ?? null;
  return null;
}
