/**
 * Core ContextCompactor implementation — LLM-based summarization.
 *
 * Compacts old conversation history into a structured summary when
 * configurable thresholds (token count, message count) are exceeded.
 */

import type { CompactionResult, ContextCompactor } from "@koi/core/context";
import type { InboundMessage } from "@koi/core/message";
import { heuristicTokenEstimator } from "./estimator.js";
import { findOptimalSplit } from "./find-split.js";
import { findValidSplitPoints } from "./pair-boundaries.js";
import { buildSummaryPrompt } from "./prompt.js";
import type { CompactionTrigger, CompactorConfig, ResolvedCompactorConfig } from "./types.js";
import { COMPACTOR_DEFAULTS } from "./types.js";

/**
 * Extended compactor with a `forceCompact` method that bypasses trigger checks.
 * Used by overflow recovery to compact regardless of thresholds.
 */
export interface LlmCompactor extends ContextCompactor {
  readonly forceCompact: (
    messages: readonly InboundMessage[],
    maxTokens: number,
    model?: string,
  ) => Promise<CompactionResult>;
}

function resolveConfig(config: CompactorConfig): ResolvedCompactorConfig {
  return {
    summarizer: config.summarizer,
    summarizerModel: config.summarizerModel,
    contextWindowSize: config.contextWindowSize ?? COMPACTOR_DEFAULTS.contextWindowSize,
    trigger: config.trigger ?? COMPACTOR_DEFAULTS.trigger,
    preserveRecent: config.preserveRecent ?? COMPACTOR_DEFAULTS.preserveRecent,
    maxSummaryTokens: config.maxSummaryTokens ?? COMPACTOR_DEFAULTS.maxSummaryTokens,
    tokenEstimator: config.tokenEstimator ?? heuristicTokenEstimator,
    promptBuilder: config.promptBuilder ?? buildSummaryPrompt,
    archiver: config.archiver,
    overflowRecovery: config.overflowRecovery ?? COMPACTOR_DEFAULTS.overflowRecovery,
  };
}

/** Check whether any trigger condition is met. */
function shouldTrigger(
  trigger: CompactionTrigger,
  tokenCount: number,
  messageCount: number,
  contextWindowSize: number,
): boolean {
  if (trigger.messageCount !== undefined && messageCount >= trigger.messageCount) {
    return true;
  }
  if (trigger.tokenCount !== undefined && tokenCount >= trigger.tokenCount) {
    return true;
  }
  if (
    trigger.tokenFraction !== undefined &&
    tokenCount >= contextWindowSize * trigger.tokenFraction
  ) {
    return true;
  }
  return false;
}

/** Check if only messageCount trigger is configured (skip token estimation). */
function needsTokenEstimation(trigger: CompactionTrigger): boolean {
  return trigger.tokenFraction !== undefined || trigger.tokenCount !== undefined;
}

/** Build a noop result (no compaction needed). */
function noopResult(messages: readonly InboundMessage[], tokenCount: number): CompactionResult {
  return {
    messages,
    originalTokens: tokenCount,
    compactedTokens: tokenCount,
    strategy: "noop",
  };
}

/**
 * Create an LLM-based ContextCompactor.
 *
 * The compactor:
 * 1. Checks trigger conditions (token fraction, count, message count).
 * 2. Finds valid split points respecting AI+Tool pair boundaries.
 * 3. Finds optimal split using prefix sums.
 * 4. Calls the summarizer LLM to produce a structured summary.
 * 5. Returns [summaryMessage, ...preservedMessages].
 */
export function createLlmCompactor(config: CompactorConfig): LlmCompactor {
  const resolved = resolveConfig(config);

  // let required: re-entrancy guard toggled within compact() to prevent concurrent summarizations
  let compacting = false;

  return {
    async compact(
      messages: readonly InboundMessage[],
      maxTokens: number,
      model?: string,
    ): Promise<CompactionResult> {
      // Re-entrancy guard: set synchronously before any awaits to block concurrent calls
      if (compacting) {
        return noopResult(messages, 0);
      }

      // Sync fast path: too few messages to compact (no await needed)
      if (messages.length <= resolved.preserveRecent) {
        return noopResult(messages, 0);
      }

      // Sync fast path: messageCount-only trigger not yet reached
      if (
        !needsTokenEstimation(resolved.trigger) &&
        resolved.trigger.messageCount !== undefined &&
        messages.length < resolved.trigger.messageCount
      ) {
        return noopResult(messages, 0);
      }

      // Set guard before any async work
      compacting = true;
      try {
        return await performCompaction(messages, maxTokens, model, resolved);
      } catch (_e: unknown) {
        // Graceful degradation: return original messages on any failure.
        // L0 contract: "Always succeeds — worst case returns an empty message array."
        return noopResult(messages, 0);
      } finally {
        compacting = false;
      }
    },

    async forceCompact(
      messages: readonly InboundMessage[],
      maxTokens: number,
      model?: string,
    ): Promise<CompactionResult> {
      return performCompaction(messages, maxTokens, model, resolved, true);
    },
  };
}

/** Core compaction logic, extracted for readability. */
async function performCompaction(
  messages: readonly InboundMessage[],
  maxTokens: number,
  model: string | undefined,
  resolved: ResolvedCompactorConfig,
  force = false,
): Promise<CompactionResult> {
  const contextWindowSize = Math.min(maxTokens, resolved.contextWindowSize);

  // Estimate tokens (skip if only messageCount trigger or forced)
  const tokenCount =
    !force && needsTokenEstimation(resolved.trigger)
      ? await resolved.tokenEstimator.estimateMessages(messages, model)
      : 0;

  // Check trigger conditions (skip when forced)
  if (!force && !shouldTrigger(resolved.trigger, tokenCount, messages.length, contextWindowSize)) {
    return noopResult(messages, tokenCount);
  }

  // For split computation we always need real token estimates
  const realTokenCount =
    tokenCount > 0 ? tokenCount : await resolved.tokenEstimator.estimateMessages(messages, model);

  // Find valid split points respecting pair boundaries
  const validSplitPoints = findValidSplitPoints(messages, resolved.preserveRecent);
  if (validSplitPoints.length === 0) {
    return noopResult(messages, realTokenCount);
  }

  // Find optimal split
  const splitIndex = await findOptimalSplit(
    messages,
    validSplitPoints,
    contextWindowSize,
    resolved.maxSummaryTokens,
    resolved.tokenEstimator,
  );

  if (splitIndex < 0) {
    return noopResult(messages, realTokenCount);
  }

  // Build prompt from head messages (to be summarized)
  const headMessages = messages.slice(0, splitIndex);
  const tailMessages = messages.slice(splitIndex);
  const prompt = resolved.promptBuilder(headMessages, resolved.maxSummaryTokens);

  // Resolve which model to use: explicit summarizerModel takes precedence
  const summarizerModel = resolved.summarizerModel ?? model;

  const response = await resolved.summarizer({
    messages: [
      {
        content: [{ kind: "text", text: prompt }],
        senderId: "system",
        timestamp: Date.now(),
      },
    ],
    ...(summarizerModel !== undefined ? { model: summarizerModel } : {}),
    maxTokens: resolved.maxSummaryTokens,
  });

  // Build summary message
  const summaryMessage: InboundMessage = {
    content: [{ kind: "text", text: response.content }],
    senderId: "system:compactor",
    timestamp: Date.now(),
    metadata: { compacted: true },
  };

  const compactedMessages: readonly InboundMessage[] = [summaryMessage, ...tailMessages];
  const compactedTokens = await resolved.tokenEstimator.estimateMessages(compactedMessages, model);

  const result: CompactionResult = {
    messages: compactedMessages,
    originalTokens: realTokenCount,
    compactedTokens,
    strategy: "llm-summary",
  };

  // Fire-and-forget: archive original messages before they disappear
  if (resolved.archiver !== undefined) {
    try {
      await resolved.archiver.archive(headMessages, response.content);
    } catch (_e: unknown) {
      // Archiver failure must never block compaction
      console.warn("[middleware-compactor] archiver.archive() failed (swallowed)");
    }
  }

  return result;
}
