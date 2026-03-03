/**
 * LLM-as-judge salience gate — filters noise before memory storage.
 *
 * Error handling: fail-open (treat as salient when classifier throws).
 */

import type { LlmClassifier, SalienceGate } from "./types.js";

const SALIENCE_PROMPT_TEMPLATE = `Does this feedback contain a personal preference worth remembering? Answer Yes or No.

Feedback: `;

export function createLlmSalienceGate(classify: LlmClassifier): SalienceGate {
  return {
    async isSalient(content: string, category: string | undefined): Promise<boolean> {
      try {
        const categoryHint = category !== undefined ? ` (category: ${category})` : "";
        const response = await classify(`${SALIENCE_PROMPT_TEMPLATE}${content}${categoryHint}`);
        const trimmed = response.trim().toLowerCase();

        if (/\byes\b/.test(trimmed)) return true;
        if (/\bno\b/.test(trimmed)) return false;

        // Malformed response — fail-open: treat as salient
        return true;
      } catch (_e: unknown) {
        // Fail-open: treat as salient when classifier throws
        return true;
      }
    },
  };
}
