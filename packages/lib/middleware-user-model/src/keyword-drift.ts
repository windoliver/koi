/**
 * Keyword-only drift detector — 8 regex patterns, zero LLM cost.
 *
 * Returns `{ drifted: true }` when the user's text matches any of the
 * canonical preference-change patterns. Captures the new value where
 * it appears in a "use X instead" / "switch to X" form.
 */

import type { DriftDecision, PreferenceDriftDetector } from "./types.js";

interface Pattern {
  readonly re: RegExp;
  readonly captureGroup?: number | undefined;
}

const PATTERNS: readonly Pattern[] = [
  { re: /\b(stop|quit) using\b/i },
  { re: /\bswitch (to|over to)\s+([\w-]+)/i, captureGroup: 2 },
  { re: /\buse\s+([\w-]+)\s+instead\b/i, captureGroup: 1 },
  { re: /\bprefer\s+([\w-]+)/i, captureGroup: 1 },
  { re: /\b(?:i|we) (?:like|prefer) ([\w-]+) (?:over|more than|better than)\b/i, captureGroup: 1 },
  { re: /\bno longer\b/i },
  { re: /\binstead of\b/i },
  { re: /\bchange (it|that) to\s+([\w-]+)/i, captureGroup: 2 },
];

export function createKeywordDriftDetector(): PreferenceDriftDetector {
  return {
    detect(text: string, _existing: readonly string[]): DriftDecision {
      for (const p of PATTERNS) {
        const m = p.re.exec(text);
        if (m === null) continue;
        const newValue = p.captureGroup !== undefined ? m[p.captureGroup] : undefined;
        return { drifted: true, newValue };
      }
      return { drifted: false };
    },
  };
}
