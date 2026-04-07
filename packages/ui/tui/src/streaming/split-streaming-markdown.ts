/**
 * Split streaming markdown at the last unclosed code fence.
 *
 * Used to separate the stable (completed) portion of streaming markdown
 * from the live tail so the stable part can be cached/memoized while only
 * the tail gets re-parsed on each frame.
 *
 * A fence is a line starting with three or more backticks (` ``` `),
 * optionally followed by a language tag. Inline backticks are not fences.
 */

// ---------------------------------------------------------------------------
// Fence detection
// ---------------------------------------------------------------------------

/**
 * Matches a code fence at the start of a line: 3+ backticks, optional
 * language tag, then end-of-line (or end-of-string).
 *
 * Captures:
 *   [1] — the backtick run (to measure width for nested fences)
 */
const FENCE_RE = /^(`{3,})[^\n]*$/gm;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Split streaming markdown at the last unclosed code fence.
 *
 * Returns stable (everything before the last unclosed fence) and tail
 * (the unclosed fence + content). If no unclosed fence, stable is the
 * full text and tail is empty.
 */
export function splitStreamingMarkdown(text: string): {
  readonly stable: string;
  readonly tail: string;
} {
  if (text.length === 0) {
    return { stable: "", tail: "" };
  }

  // Collect all fence positions + widths
  const fences: readonly { readonly index: number; readonly width: number }[] = collectFences(text);

  if (fences.length === 0) {
    // No fences at all
    return { stable: text, tail: "" };
  }

  // Walk fences to pair openers with closers.
  // A closer must have width >= the opener it closes.
  // While inside an open block, fences with fewer backticks are content, not
  // structure — they are skipped entirely (per CommonMark rules).
  let opener: { readonly index: number; readonly width: number } | undefined;
  // Track the last unclosed opener after full scan
  let lastUnclosedOpener: { readonly index: number; readonly width: number } | undefined;

  for (const fence of fences) {
    if (opener !== undefined) {
      if (fence.width >= opener.width) {
        // This fence closes the current opener
        opener = undefined;
      }
      // Fences with fewer backticks are content inside the block — skip
    } else {
      // No open block — this fence starts a new one
      opener = fence;
      lastUnclosedOpener = fence;
    }
  }

  // If opener is undefined, the last block was closed
  if (opener === undefined) {
    lastUnclosedOpener = undefined;
  }

  if (lastUnclosedOpener === undefined) {
    // All fences are closed
    return { stable: text, tail: "" };
  }

  // The unclosed opener determines the split point
  const splitIndex = lastUnclosedOpener.index;

  return {
    stable: text.slice(0, splitIndex),
    tail: text.slice(splitIndex),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function collectFences(
  text: string,
): readonly { readonly index: number; readonly width: number }[] {
  const result: { readonly index: number; readonly width: number }[] = [];
  // Reset lastIndex since the regex is global
  FENCE_RE.lastIndex = 0;

  let match: RegExpExecArray | null = FENCE_RE.exec(text);
  while (match !== null) {
    result.push({ index: match.index, width: match[1]?.length });
    match = FENCE_RE.exec(text);
  }

  return result;
}
