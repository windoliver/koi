/**
 * LLM-as-judge salience gate. Fail-open: when the classifier errors out
 * we treat the candidate as salient so a real preference is not silently
 * dropped.
 */

import type { LlmClassifier, SalienceGate } from "./types.js";

const PROMPT_PREAMBLE =
  "Decide whether the following user statement is a durable preference worth remembering, or transient chatter.\n" +
  'Reply with strict JSON: {"salient": boolean}.';

export function createLlmSalienceGate(classify: LlmClassifier): SalienceGate {
  return {
    async isSalient(text: string): Promise<boolean> {
      try {
        const raw = await classify(`${PROMPT_PREAMBLE}\n\nStatement:\n${text}`);
        const parsed = JSON.parse(raw) as { readonly salient?: boolean };
        return parsed.salient !== false;
      } catch {
        return true;
      }
    },
  };
}
