/**
 * LLM-based drift detector — uses a classifier callback to detect
 * preference changes with old→new extraction.
 *
 * Error handling: fail-closed (assume drift when classifier throws).
 */

import type { PreferenceDriftDetector, PreferenceDriftSignal } from "./keyword-drift.js";
import type { LlmClassifier } from "./llm-salience.js";

const DRIFT_PROMPT_TEMPLATE = `Does this message indicate the user's preference has changed?
If yes, reply: YES: old=<old preference> new=<new preference>
If no, reply: NO

Message: `;

const YES_REGEX = /^YES(?::\s*old=(.+?)\s+new=(.+))?$/i;

function parseResponse(raw: string): PreferenceDriftSignal {
  const trimmed = raw.trim();

  if (/^NO\b/i.test(trimmed)) {
    return { kind: "no_drift" };
  }

  const match = YES_REGEX.exec(trimmed);
  if (match !== null) {
    return {
      kind: "drift_detected",
      oldPreference: match[1]?.trim(),
      newPreference: match[2]?.trim() ?? trimmed,
    };
  }

  // Malformed response — fail-closed: assume drift
  return {
    kind: "drift_detected",
    newPreference: trimmed,
  };
}

export function createLlmDriftDetector(classify: LlmClassifier): PreferenceDriftDetector {
  return {
    async detect(feedback: string): Promise<PreferenceDriftSignal> {
      try {
        const response = await classify(`${DRIFT_PROMPT_TEMPLATE}${feedback}`);
        return parseResponse(response);
      } catch (_e: unknown) {
        // Fail-closed: assume drift when classifier throws
        return {
          kind: "drift_detected",
          newPreference: feedback,
        };
      }
    },
  };
}
