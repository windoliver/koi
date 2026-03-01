/**
 * Keyword-based drift detector — pure heuristic, no LLM cost.
 *
 * Scans user feedback for change-indicating phrases (e.g., "no longer",
 * "changed my mind", "prefer X instead"). Returns a drift signal when
 * any pattern matches.
 */

import type { PreferenceDriftDetector, PreferenceDriftSignal } from "./types.js";

const DEFAULT_DRIFT_PATTERNS: readonly RegExp[] = [
  /\bno longer\b/i,
  /\bnot anymore\b/i,
  /\bchanged?\s+my\s+mind\b/i,
  /\bprefer\s+.+\s+instead\b/i,
  /\b(?:don'?t|do\s+not)\s+(?:like|want|use)\b/i,
  /\b(?:actually\s+I?\s*(?:want|prefer|use))\b/i,
  /\bswitch\s+(?:to|from)\b/i,
  /\bfrom\s+now\s+on\b/i,
];

export interface KeywordDriftOptions {
  readonly additionalPatterns?: readonly RegExp[] | undefined;
}

export function createKeywordDriftDetector(options?: KeywordDriftOptions): PreferenceDriftDetector {
  const patterns: readonly RegExp[] =
    options?.additionalPatterns !== undefined && options.additionalPatterns.length > 0
      ? [...DEFAULT_DRIFT_PATTERNS, ...options.additionalPatterns]
      : DEFAULT_DRIFT_PATTERNS;

  return {
    detect(feedback: string): PreferenceDriftSignal {
      for (const pattern of patterns) {
        const match = pattern.exec(feedback);
        if (match !== null) {
          return {
            kind: "drift_detected",
            newPreference: feedback,
          };
        }
      }
      return { kind: "no_drift" };
    },
  };
}
