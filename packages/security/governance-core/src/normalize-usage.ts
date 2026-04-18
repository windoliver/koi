import type { JsonObject } from "@koi/core";
import type { ModelResponse } from "@koi/core/middleware";

export interface NormalizedUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly reasoningTokens: number;
}

const ZERO: NormalizedUsage = Object.freeze({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
});

function readNumber(obj: JsonObject | undefined, key: string): number {
  if (obj === undefined) return 0;
  const v = obj[key];
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0;
}

export function normalizeUsage(
  usage: ModelResponse["usage"],
  metadata?: JsonObject,
): NormalizedUsage {
  if (usage === undefined) return ZERO;
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadTokens: usage.cacheReadTokens ?? 0,
    cacheWriteTokens: usage.cacheWriteTokens ?? 0,
    reasoningTokens: readNumber(metadata, "reasoningTokens"),
  };
}
