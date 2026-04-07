/**
 * Close unclosed markdown formatting for streaming display.
 *
 * When markdown is being streamed token-by-token, formatting markers may be
 * incomplete. This function appends the minimal closing markers so the
 * partial markdown renders correctly in a terminal or preview pane.
 *
 * Pure function, no dependencies.
 */

// ---------------------------------------------------------------------------
// Fence detection (reused from split-streaming-markdown)
// ---------------------------------------------------------------------------

/** Matches a code fence at the start of a line: 3+ backticks. */
const FENCE_RE = /^`{3,}[^\n]*$/gm;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Close unclosed markdown formatting for streaming display.
 * Appends closing markers so partial markdown renders correctly.
 */
export function healMarkdown(text: string): string {
  if (text.length === 0) return "";

  let healed = text;

  // 1. Unclosed code fences
  healed = healCodeFences(healed);

  // 2. Unclosed inline code (odd number of unescaped backticks)
  healed = healInlineMarker(healed, "`");

  // 3. Unclosed bold (**)
  healed = healDoubleMarker(healed, "**");

  // 4. Unclosed italic (* or _)
  healed = healInlineMarker(healed, "*");
  healed = healInlineMarker(healed, "_");

  // 5. Unclosed link URL: [text](url  — missing )
  if (/\[[^\]]*\]\([^)]*$/.test(healed)) {
    healed += ")";
  }

  // 6. Unclosed link text: [text  — missing ]
  //    Only match if not already handled by step 5 (no `](` after the `[`)
  if (/\[[^\]]*$/.test(healed) && !/\[[^\]]*\]\(/.test(healed)) {
    healed += "]";
  }

  return healed;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Close unclosed code fences by counting fence lines.
 * If the count is odd, append a newline + closing fence.
 */
function healCodeFences(text: string): string {
  FENCE_RE.lastIndex = 0;
  let count = 0;
  while (FENCE_RE.exec(text) !== null) {
    count++;
  }
  if (count % 2 === 1) {
    return `${text}\n\`\`\``;
  }
  return text;
}

/**
 * If a double marker (like `**`) appears an odd number of times,
 * append a closing one. Counts non-overlapping occurrences.
 */
function healDoubleMarker(text: string, marker: string): string {
  let count = 0;
  let idx = 0;
  while (idx < text.length) {
    const pos = text.indexOf(marker, idx);
    if (pos === -1) break;
    // Skip if preceded by backslash
    if (pos > 0 && text[pos - 1] === "\\") {
      idx = pos + marker.length;
      continue;
    }
    count++;
    idx = pos + marker.length;
  }
  if (count % 2 === 1) {
    return text + marker;
  }
  return text;
}

/**
 * If a single-character marker (like `` ` ``, `*`, `_`) appears an odd
 * number of times (excluding escaped ones and, for `*`/`_`, those that
 * are part of `**`), append a closing one.
 */
function healInlineMarker(text: string, marker: string): string {
  let count = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === marker) {
      // Skip if escaped
      if (i > 0 && text[i - 1] === "\\") continue;
      // For * and _, skip if part of a ** pair
      if ((marker === "*" || marker === "_") && i + 1 < text.length && text[i + 1] === marker) {
        i++; // skip the pair — handled by healDoubleMarker
        continue;
      }
      if ((marker === "*" || marker === "_") && i > 0 && text[i - 1] === marker) {
        // Second char of a **, already skipped above
        continue;
      }
      count++;
    }
  }
  if (count % 2 === 1) {
    return text + marker;
  }
  return text;
}
