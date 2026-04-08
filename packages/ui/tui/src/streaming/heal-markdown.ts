/**
 * Close unclosed markdown formatting for streaming display.
 *
 * When markdown is being streamed token-by-token, formatting markers may be
 * incomplete. This function appends the minimal closing markers so the
 * partial markdown renders correctly in a terminal or preview pane.
 *
 * Code-aware: does NOT heal markers inside code fences or inline code spans.
 * This prevents `snake_case`, env vars, JSON fragments, and other code-like
 * content from gaining spurious closing markers during streaming.
 *
 * Pure function, no dependencies.
 */

// ---------------------------------------------------------------------------
// Fence detection
// ---------------------------------------------------------------------------

/** Matches a code fence at the start of a line: 3+ backticks. */
const FENCE_RE = /^`{3,}[^\n]*$/gm;

// ---------------------------------------------------------------------------
// Code-aware text extraction
// ---------------------------------------------------------------------------

/**
 * Strip code fences and inline code spans from text, returning only the
 * prose portions where markdown formatting markers are meaningful.
 * This prevents healing markers that appear inside code contexts.
 */
function extractProse(text: string): string {
  // 1. Remove fenced code blocks (complete ones)
  // Match ``` ... ``` across lines
  let prose = text.replace(/^`{3,}[^\n]*\n[\s\S]*?^`{3,}\s*$/gm, "");

  // 2. If there's an unclosed fence, remove everything from the fence onward
  FENCE_RE.lastIndex = 0;
  const fences: number[] = [];
  // `let` justified: loop variable for regex exec iteration
  let fenceMatch = FENCE_RE.exec(prose);
  while (fenceMatch !== null) {
    fences.push(fenceMatch.index);
    fenceMatch = FENCE_RE.exec(prose);
  }
  if (fences.length % 2 === 1) {
    // Odd fence — unclosed. Remove from the last fence to end
    const lastFence = fences[fences.length - 1];
    if (lastFence !== undefined) {
      prose = prose.slice(0, lastFence);
    }
  }

  // 3. Remove inline code spans (`` `...` ``)
  prose = prose.replace(/`[^`]*`/g, "");

  return prose;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Close unclosed markdown formatting for streaming display.
 * Appends closing markers so partial markdown renders correctly.
 *
 * Code-aware: only heals markers in prose, not inside code fences or
 * inline code spans. `snake_case`, backtick-quoted content, and fenced
 * code blocks are left untouched.
 */
export function healMarkdown(text: string): string {
  if (text.length === 0) return "";

  let healed = text;

  // 1. Unclosed code fences (checked on full text — fences are structural)
  healed = healCodeFences(healed);

  // Extract prose (no code) for marker counting
  const prose = extractProse(text);

  // 2. Unclosed inline code (odd backticks in prose only)
  if (countUnescaped(prose, "`") % 2 === 1) {
    healed += "`";
  }

  // 3. Unclosed bold (**) in prose
  if (countDouble(prose, "**") % 2 === 1) {
    healed += "**";
  }

  // 4. Unclosed italic (* or _) in prose — skip pairs already counted as **
  if (countSingleMarker(prose, "*") % 2 === 1) {
    healed += "*";
  }
  if (countSingleMarker(prose, "_") % 2 === 1) {
    healed += "_";
  }

  // 5. Unclosed link URL in prose: [text](url  — missing )
  if (/\[[^\]]*\]\([^)]*$/.test(prose)) {
    healed += ")";
  }

  // 6. Unclosed link text in prose: [text  — missing ]
  if (/\[[^\]]*$/.test(prose) && !/\[[^\]]*\]\(/.test(prose)) {
    healed += "]";
  }

  return healed;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Close unclosed code fences by tracking opener widths on the FULL text.
 * CommonMark requires the closing fence to be at least as wide as the opener.
 * Always emits a closer matching the unmatched opener's width.
 */
function healCodeFences(text: string): string {
  FENCE_RE.lastIndex = 0;
  // Stack of unmatched opener widths
  const openerWidths: number[] = [];
  let fenceMatch = FENCE_RE.exec(text);
  while (fenceMatch !== null) {
    const fenceStr = fenceMatch[0];
    // Count leading backticks (the fence width)
    let width = 0;
    for (const ch of fenceStr) {
      if (ch === "`") width++;
      else break;
    }
    if (openerWidths.length > 0) {
      const topWidth = openerWidths[openerWidths.length - 1];
      if (topWidth !== undefined && width >= topWidth) {
        // This fence closes the current opener
        openerWidths.pop();
      } else {
        // Narrower fence inside an open block — treated as content by CommonMark.
        // Or this is a new opener (no open block with wider fence).
        // If no open block, it's a new opener.
        if (openerWidths.length === 0) {
          openerWidths.push(width);
        }
        // Otherwise it's content inside the open block — skip
      }
    } else {
      // No open block — this is an opener
      openerWidths.push(width);
    }
    fenceMatch = FENCE_RE.exec(text);
  }
  if (openerWidths.length > 0) {
    // Close the last unmatched opener with matching width
    const width = openerWidths[openerWidths.length - 1] ?? 3;
    return `${text}\n${"`".repeat(width)}`;
  }
  return text;
}

/** Count non-overlapping unescaped occurrences of a single character. */
function countUnescaped(text: string, char: string): number {
  let count = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === char && (i === 0 || text[i - 1] !== "\\")) {
      count++;
    }
  }
  return count;
}

/** Count non-overlapping unescaped occurrences of a double marker (e.g. `**`). */
function countDouble(text: string, marker: string): number {
  let count = 0;
  let idx = 0;
  while (idx < text.length) {
    const pos = text.indexOf(marker, idx);
    if (pos === -1) break;
    if (pos > 0 && text[pos - 1] === "\\") {
      idx = pos + marker.length;
      continue;
    }
    count++;
    idx = pos + marker.length;
  }
  return count;
}

/** Check if a character is a word character (letter, digit, underscore). */
function isWordChar(ch: string | undefined): boolean {
  if (ch === undefined) return false;
  return /\w/.test(ch);
}

/**
 * Count single markers (*, _) excluding those that are part of double markers
 * and those that are word-internal (e.g., `snake_case`, `MY_VAR`).
 * Per CommonMark, `_` only starts/ends emphasis at word boundaries.
 */
function countSingleMarker(text: string, marker: string): number {
  let count = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== marker) continue;
    if (i > 0 && text[i - 1] === "\\") continue;
    // Skip if part of a ** or __ pair
    if (i + 1 < text.length && text[i + 1] === marker) {
      i++;
      continue;
    }
    if (i > 0 && text[i - 1] === marker) continue;
    // For `_`: skip word-internal underscores (snake_case, MY_VAR).
    // CommonMark rule: _ emphasis requires non-word char on at least one side.
    if (marker === "_" && isWordChar(text[i - 1]) && isWordChar(text[i + 1])) {
      continue;
    }
    count++;
  }
  return count;
}
