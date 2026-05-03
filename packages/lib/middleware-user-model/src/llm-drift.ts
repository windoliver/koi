/**
 * LLM-backed drift detector. Wraps a classifier function whose response
 * is parsed for a JSON object of shape `{ drifted, oldValue?, newValue? }`.
 * Falls back to fail-closed (`drifted: true`) when parsing fails, matching
 * the "fail-closed on drift" rule from the package doc.
 */

import type { DriftDecision, LlmClassifier, PreferenceDriftDetector } from "./types.js";

const PROMPT_PREAMBLE =
  "Decide whether the user's most recent message changes a previously stated preference.\n" +
  'Reply with strict JSON: {"drifted": boolean, "oldValue"?: string, "newValue"?: string}.';

export function createLlmDriftDetector(classify: LlmClassifier): PreferenceDriftDetector {
  return {
    async detect(text: string, existing: readonly string[]): Promise<DriftDecision> {
      const prompt = `${PROMPT_PREAMBLE}\n\nExisting preferences:\n${existing.join("\n")}\n\nMessage:\n${text}`;
      const raw = await classify(prompt);
      try {
        const parsed = JSON.parse(raw) as DriftDecision;
        return {
          drifted: parsed.drifted === true,
          oldValue: parsed.oldValue,
          newValue: parsed.newValue,
        };
      } catch {
        return { drifted: true };
      }
    },
  };
}
