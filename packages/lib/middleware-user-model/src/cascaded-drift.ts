/**
 * Cascaded drift detector — runs the keyword detector first, then asks the
 * LLM only when keywords matched. This keeps cost near zero on the common
 * no-drift path while still catching nuanced changes a regex would miss.
 */

import { createKeywordDriftDetector } from "./keyword-drift.js";
import { createLlmDriftDetector } from "./llm-drift.js";
import type { DriftDecision, LlmClassifier, PreferenceDriftDetector } from "./types.js";

export function createCascadedDriftDetector(classify: LlmClassifier): PreferenceDriftDetector {
  const keyword = createKeywordDriftDetector();
  const llm = createLlmDriftDetector(classify);
  return {
    async detect(text: string, existing: readonly string[]): Promise<DriftDecision> {
      const k = await keyword.detect(text, existing);
      if (!k.drifted) return k;
      return llm.detect(text, existing);
    },
  };
}
