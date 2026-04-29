/**
 * Pure reassembly: combine N segmented `ModelResponse`s into a single
 * response that downstream callers can treat as if the model had answered
 * the original (oversized) request once.
 */

import type { ModelContentBlock, ModelResponse } from "@koi/core";

/** Separator inserted between segment text bodies in the combined content. */
export const SEGMENT_SEPARATOR = "\n\n";

interface UsageTotals {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens?: number | undefined;
  readonly cacheWriteTokens?: number | undefined;
}

function sumUsage(parts: readonly ModelResponse[]): UsageTotals | undefined {
  let any = false; // let: presence flag while folding
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let hasCacheRead = false;
  let hasCacheWrite = false;
  for (const part of parts) {
    if (part.usage === undefined) continue;
    any = true;
    inputTokens += part.usage.inputTokens;
    outputTokens += part.usage.outputTokens;
    if (part.usage.cacheReadTokens !== undefined) {
      cacheReadTokens += part.usage.cacheReadTokens;
      hasCacheRead = true;
    }
    if (part.usage.cacheWriteTokens !== undefined) {
      cacheWriteTokens += part.usage.cacheWriteTokens;
      hasCacheWrite = true;
    }
  }
  if (!any) return undefined;
  return {
    inputTokens,
    outputTokens,
    ...(hasCacheRead ? { cacheReadTokens } : {}),
    ...(hasCacheWrite ? { cacheWriteTokens } : {}),
  };
}

function concatRichContent(
  parts: readonly ModelResponse[],
): readonly ModelContentBlock[] | undefined {
  const blocks: ModelContentBlock[] = [];
  let any = false; // let: presence flag for richContent across parts
  for (const part of parts) {
    if (part.richContent === undefined) continue;
    any = true;
    for (const block of part.richContent) blocks.push(block);
  }
  return any ? blocks : undefined;
}

/**
 * Concatenate segmented responses in order. The first response supplies
 * `model`, `responseId`, and `metadata`; the last supplies `stopReason`.
 * Usage tokens are summed across parts.
 *
 * @throws if `parts` is empty.
 */
export function reassembleResponses(parts: readonly ModelResponse[]): ModelResponse {
  if (parts.length === 0) {
    throw new Error("reassembleResponses requires at least one response");
  }
  const first = parts[0];
  const last = parts[parts.length - 1];
  if (first === undefined || last === undefined) {
    throw new Error("reassembleResponses received holes in the parts array");
  }
  if (parts.length === 1) return first;

  const content = parts.map((p) => p.content).join(SEGMENT_SEPARATOR);
  const usage = sumUsage(parts);
  const richContent = concatRichContent(parts);

  const out: ModelResponse = {
    content,
    model: first.model,
    ...(usage !== undefined ? { usage } : {}),
    ...(first.metadata !== undefined ? { metadata: first.metadata } : {}),
    ...(last.stopReason !== undefined ? { stopReason: last.stopReason } : {}),
    ...(first.responseId !== undefined ? { responseId: first.responseId } : {}),
    ...(richContent !== undefined ? { richContent } : {}),
  };
  return out;
}
