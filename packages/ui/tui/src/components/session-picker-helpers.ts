/**
 * Pure formatting helpers for SessionPicker — exported as a plain .ts file so
 * tests can import them without triggering the JSX runtime.
 */

import type { SessionSummary } from "../state/types.js";

export function formatSessionDate(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export const getSessionDescription = (s: SessionSummary): string =>
  `${formatSessionDate(s.lastActivityAt)} · ${s.messageCount} messages · ${s.preview.slice(0, 40)}`;

/**
 * Max terminal column width for peek panel lines.
 * Modal is 70 cols; border + padding = 4, leaving 66 usable columns.
 */
export const PEEK_PREVIEW_MAX = 66;

/**
 * Terminal display width of a single Unicode code point.
 * Covers common CJK and emoji ranges that render as 2 columns.
 * Zero-width control characters contribute 0 columns.
 */
function charDisplayWidth(cp: string): number {
  const c = cp.codePointAt(0) ?? 0;
  if (
    (c >= 0x1100 && c <= 0x115f) || // Hangul Jamo
    (c >= 0x2e80 && c <= 0x303e) || // CJK Radicals + Kangxi
    (c >= 0x3040 && c <= 0x9fff) || // CJK / Kana / Bopomofo / CJK Extension A / CJK Unified Ideographs
    (c >= 0xf900 && c <= 0xfaff) || // CJK Compatibility Ideographs
    (c >= 0xfe10 && c <= 0xfe1f) || // Vertical Forms
    (c >= 0xfe30 && c <= 0xfe4f) || // CJK Compatibility Forms
    (c >= 0xff01 && c <= 0xff60) || // Fullwidth ASCII / Roman
    (c >= 0xffe0 && c <= 0xffe6) || // Fullwidth Signs
    (c >= 0x1f100 && c <= 0x1feff) || // Emoji / Misc Symbols / Regional Indicators
    (c >= 0x20000 && c <= 0x3fffd) // CJK Extension B-H
  )
    return 2;
  if (c === 0 || (c >= 0x200b && c <= 0x200f) || (c >= 0x2028 && c <= 0x202f)) return 0;
  return 1;
}

const _segmenter = new Intl.Segmenter();

/**
 * Display width of one grapheme cluster.
 * Width = width of the first non-zero-width code point in the cluster so that
 * ZWJ sequences (👨‍👩‍👧), flags (🇺🇸), and variation selectors all collapse
 * to the width of their base glyph rather than summing code-point widths.
 */
function graphemeDisplayWidth(grapheme: string): number {
  for (const cp of grapheme) {
    const w = charDisplayWidth(cp);
    if (w > 0) return w;
  }
  return 1;
}

/**
 * Clip `s` so its terminal display width stays within `maxCols`.
 * Segments by grapheme cluster (Intl.Segmenter) so multi-code-point emoji
 * such as flags and ZWJ sequences are never split mid-glyph.
 * Reserves one column for the ellipsis when truncation is needed so the
 * result always fits: w(content) + 1(ellipsis) ≤ maxCols.
 */
function capLine(s: string, maxCols: number = PEEK_PREVIEW_MAX): string {
  const graphemes = [..._segmenter.segment(s)];
  let w = 0;
  let charIdx = 0;
  for (let gi = 0; gi < graphemes.length; gi++) {
    const seg = graphemes[gi];
    const gw = graphemeDisplayWidth(seg?.segment ?? "");
    const hasMore = gi < graphemes.length - 1;
    if (w + gw + (hasMore ? 1 : 0) > maxCols) {
      return `${s.slice(0, charIdx)}…`;
    }
    w += gw;
    charIdx += (seg?.segment ?? "").length;
  }
  return s;
}

export function getSessionPeekLines(s: SessionSummary): readonly string[] {
  const date = formatSessionDate(s.lastActivityAt);
  const normalized = s.preview.replace(/\r?\n|\r/g, " ");
  return [capLine(s.name), capLine(`${date} · ${s.messageCount} messages`), capLine(normalized)];
}
