/**
 * Correction detector — identifies preference corrections in user messages.
 */

import type { InboundMessage } from "@koi/core/message";

export interface CorrectionAssessment {
  readonly corrective: boolean;
  readonly preferenceUpdate?: string;
}

export interface CorrectionDetector {
  readonly detect: (
    message: string,
    recentContext: readonly InboundMessage[],
  ) => CorrectionAssessment | Promise<CorrectionAssessment>;
}

/** Ordered by specificity — more specific markers first to prefer longer matches. */
const CORRECTION_MARKERS: readonly string[] = [
  "not what i",
  "i meant",
  "please use",
  "change to",
  "switch to",
  "i prefer",
  "don't do that",
  "instead,",
  "actually,",
  "no,",
  "wrong",
];

/** False-positive exclusions — phrases starting with "no" that aren't corrections. */
const FALSE_POSITIVE_PREFIXES: readonly string[] = [
  "no problem",
  "no worries",
  "no thanks",
  "no need",
  "no issue",
];

const MAX_PREFERENCE_LENGTH = 200;

export function createDefaultCorrectionDetector(): CorrectionDetector {
  return {
    detect(message: string, _recentContext: readonly InboundMessage[]): CorrectionAssessment {
      if (message.length === 0) {
        return { corrective: false };
      }

      const lower = message.toLowerCase().trim();

      // Check false-positive prefixes first
      if (FALSE_POSITIVE_PREFIXES.some((fp) => lower.startsWith(fp))) {
        return { corrective: false };
      }

      for (const marker of CORRECTION_MARKERS) {
        const idx = lower.indexOf(marker);
        if (idx !== -1) {
          // Extract the preference text after the marker
          const afterMarker = message.slice(idx + marker.length).trim();
          const preferenceUpdate =
            afterMarker.length > MAX_PREFERENCE_LENGTH
              ? afterMarker.slice(0, MAX_PREFERENCE_LENGTH)
              : afterMarker;

          return {
            corrective: true,
            preferenceUpdate: preferenceUpdate.length > 0 ? preferenceUpdate : message,
          };
        }
      }

      return { corrective: false };
    },
  };
}
