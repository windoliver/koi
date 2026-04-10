import type { InboundMessage, TokenEstimator } from "@koi/core";
import { maybeAwait } from "./async-util.js";
import { matchAssistantToolPairs } from "./pair-boundaries.js";
import type { CompactionEvent } from "./types.js";

export interface SelectivePruneResult {
  readonly messages: readonly InboundMessage[];
  readonly pairsRemoved: number;
  readonly tokensSaved: number;
  readonly events: readonly CompactionEvent[];
}

export async function selectivelyPrune(
  messages: readonly InboundMessage[],
  prunePreserveLastK: number,
  estimator: TokenEstimator,
): Promise<SelectivePruneResult> {
  const matchedPairs = matchAssistantToolPairs(messages);
  const pairsToKeep =
    prunePreserveLastK > 0 ? matchedPairs.slice(-prunePreserveLastK) : matchedPairs.slice(0, 0);
  const keepIndices = new Set<number>();

  for (const pair of pairsToKeep) {
    keepIndices.add(pair.assistantIdx);
    keepIndices.add(pair.toolIdx);
  }

  const pairsToRemove = matchedPairs.filter(
    (pair) => !keepIndices.has(pair.assistantIdx) || !keepIndices.has(pair.toolIdx),
  );

  if (pairsToRemove.length === 0) {
    return {
      messages,
      pairsRemoved: 0,
      tokensSaved: 0,
      events: [],
    };
  }

  const indicesToRemove = new Set<number>();
  for (const pair of pairsToRemove) {
    indicesToRemove.add(pair.assistantIdx);
    indicesToRemove.add(pair.toolIdx);
  }

  const prunedMessages = messages.filter((_, idx) => !indicesToRemove.has(idx));
  const tokensBefore = await maybeAwait(estimator.estimateMessages(messages));
  const tokensAfter = await maybeAwait(estimator.estimateMessages(prunedMessages));
  const tokensSaved = Math.max(0, tokensBefore - tokensAfter);
  const events: readonly CompactionEvent[] = [
    {
      kind: "tool_output.pruned",
      pairsRemoved: pairsToRemove.length,
      tokensSaved,
    },
  ];

  return {
    messages: prunedMessages,
    pairsRemoved: pairsToRemove.length,
    tokensSaved,
    events,
  };
}
