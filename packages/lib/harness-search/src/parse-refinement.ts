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

// Line-oriented opener match: ``` followed by an ASCII-letter language
// token (capture group 1; may be empty) plus an optional info-string
// (filename, attrs) consumed and ignored. Must occupy the whole line —
// triple-backticks mid-string in code don't open a fence.
const FENCE_OPEN = /^```([a-zA-Z]*)[^\n]*$/;
// Line-oriented closer: a line that is EXACTLY ``` (optionally trailed
// by whitespace). A standalone ``` line on its own ends the block.
const FENCE_CLOSE = /^```\s*$/;

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
  // Line-oriented scan. A regex with `[\s\S]*?...\n```` will close at
  // ANY newline-prefixed triple-backtick run, even one buried mid-line
  // inside body content (e.g. a JS template literal carrying a markdown
  // example). Walking lines explicitly lets us recognize a fence ONLY
  // when it occupies a whole line — which is what markdown semantics
  // actually require, and what most LLMs emit. Body content with inline
  // triple-backticks (e.g. `before```after` on one line) is preserved
  // verbatim.
  const lines = raw.split("\n");
  const blocks: { readonly tag: string; readonly body: string }[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    const open = FENCE_OPEN.exec(line);
    if (open === null) {
      i += 1;
      continue;
    }
    const tag = (open[1] ?? "").toLowerCase();
    let j = i + 1;
    while (j < lines.length && !FENCE_CLOSE.test(lines[j] ?? "")) j += 1;
    if (j >= lines.length) {
      // Unclosed fence at EOF — refuse to guess where the body ends.
      // A trailing fragment without a closing line is almost always
      // model truncation; evaluating the partial body would feed
      // syntactically broken code into the verifier.
      break;
    }
    const body = lines
      .slice(i + 1, j)
      .join("\n")
      .trim();
    if (body.length > 0) blocks.push({ tag, body });
    i = j + 1;
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
