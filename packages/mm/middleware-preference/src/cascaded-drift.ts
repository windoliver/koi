/**
 * Cascaded drift detector — keyword pre-filter followed by LLM confirmation.
 *
 * Flow:
 * 1. Run keyword detector (free, fast)
 * 2. If no keyword match → return no_drift (skip LLM)
 * 3. If keyword match → run LLM for confirmation + old/new extraction
 * 4. Return LLM result
 */

import type { TurnContext } from "@koi/core/middleware";
import { createKeywordDriftDetector } from "./keyword-drift.js";
import { createLlmDriftDetector } from "./llm-drift.js";
import type { LlmClassifier, PreferenceDriftDetector, PreferenceDriftSignal } from "./types.js";

export interface CascadedDriftOptions {
  readonly additionalPatterns?: readonly RegExp[] | undefined;
}

export function createCascadedDriftDetector(
  classify: LlmClassifier,
  options?: CascadedDriftOptions,
): PreferenceDriftDetector {
  const keywordDetector = createKeywordDriftDetector({
    additionalPatterns: options?.additionalPatterns,
  });
  const llmDetector = createLlmDriftDetector(classify);

  return {
    async detect(feedback: string, ctx: TurnContext): Promise<PreferenceDriftSignal> {
      const keywordResult = await keywordDetector.detect(feedback, ctx);

      if (keywordResult.kind === "no_drift") {
        return keywordResult;
      }

      // Keyword hit — confirm with LLM for richer extraction
      return llmDetector.detect(feedback, ctx);
    },
  };
}
