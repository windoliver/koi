/**
 * Budget enforcement — deterministic cascade orchestrator.
 *
 * Wires content replacement → compaction policy → microcompact into
 * a single pipeline with named stop conditions.
 *
 * Cascade (replacement is NON-TERMINAL — always continues to budget check):
 *   1. EVALUATE replacement on new tool results (pre-ingestion)
 *   2. Estimate tokens on POST-INGESTION state (messages + new results)
 *   3. Check policy and return composite result
 *
 * Cleanup is NOT performed here — the caller has the full conversation
 * state and is responsible for calling store.cleanup() with the complete
 * set of active refs across all surviving messages.
 */

import type { InboundMessage, TokenEstimator } from "@koi/core";
import type { ReplacementRef, ReplacementStore } from "@koi/core/replacement";
import { maybeAwait } from "./async-util.js";
import { findOptimalSplit } from "./find-split.js";
import { microcompact } from "./micro-compact.js";
import { findValidSplitPoints, rescuePinnedGroups } from "./pair-boundaries.js";
import { shouldCompact } from "./policy.js";
import type { ReplacementOutcome } from "./replacement.js";
import { collectRefsFromOutcomes, evaluateMessageResults } from "./replacement.js";
import type { ResolvedConfig } from "./types.js";
import { COMPACTION_DEFAULTS } from "./types.js";

// ---------------------------------------------------------------------------
// Stop conditions
// ---------------------------------------------------------------------------

/** Named stop condition for the compaction axis. */
export type CompactionSignal = "noop" | "micro" | "full";

// ---------------------------------------------------------------------------
// Budget enforcement result
// ---------------------------------------------------------------------------

/** Replacement info attached to any result when replacement occurred. */
export interface ReplacementInfo {
  /** Preview texts (one per input result). Unreplaced results have their original content. */
  readonly previews: readonly string[];
  /** Outcomes for each input result. */
  readonly outcomes: readonly ReplacementOutcome[];
  /** Total tokens saved by replacement. */
  readonly tokensSaved: number;
  /** All refs produced by replacement in this turn (for caller's ref tracking). */
  readonly activeRefs: ReadonlySet<ReplacementRef>;
}

/** Result of enforcing the token budget on a conversation turn. */
export type BudgetEnforcementResult =
  | {
      readonly compaction: "noop";
      readonly messages: readonly InboundMessage[];
      readonly totalTokens: number;
      /** Present only when replacement occurred in this turn. */
      readonly replacement?: ReplacementInfo;
    }
  | {
      readonly compaction: "micro";
      readonly messages: readonly InboundMessage[];
      readonly originalTokens: number;
      readonly compactedTokens: number;
      readonly strategy: string;
      readonly replacement?: ReplacementInfo;
      /** Messages that were dropped by micro-compaction (excludes rescued pinned messages). */
      readonly droppedMessages?: readonly InboundMessage[];
      /** True when the onBeforeDrop callback threw — preservation may have failed. */
      readonly preservationFailed?: boolean;
      /** The error thrown by onBeforeDrop, for caller logging/alerting. */
      readonly preservationError?: unknown;
    }
  | {
      readonly compaction: "full";
      readonly messages: readonly InboundMessage[];
      readonly splitIdx: number;
      readonly totalTokens: number;
      readonly replacement?: ReplacementInfo;
      /** Messages that will be dropped by full compaction (excludes rescued pinned messages). */
      readonly droppedMessages?: readonly InboundMessage[];
      /** True when the onBeforeDrop callback threw — preservation may have failed. */
      readonly preservationFailed?: boolean;
      /** The error thrown by onBeforeDrop, for caller logging/alerting. */
      readonly preservationError?: unknown;
    };

// ---------------------------------------------------------------------------
// Config subset for budget enforcement
// ---------------------------------------------------------------------------

export interface BudgetConfig {
  readonly contextWindowSize?: number;
  readonly preserveRecent?: number;
  readonly tokenEstimator?: TokenEstimator;
  readonly softTriggerFraction?: number;
  readonly hardTriggerFraction?: number;
  readonly microTargetFraction?: number;
  readonly maxResultTokens?: number;
  readonly maxMessageTokens?: number;
  readonly previewChars?: number;
  readonly maxSummaryTokens?: number;
  /**
   * Called with messages about to be dropped before compaction returns.
   * Allows callers to extract decision-relevant facts (approvals, constraints,
   * pricing rationale) before they are permanently lost from the prompt.
   */
  readonly onBeforeDrop?: (messages: readonly InboundMessage[]) => void | Promise<void>;
}

/**
 * Build a BudgetConfig from a ResolvedConfig.
 */
export function budgetConfigFromResolved(resolved: ResolvedConfig): BudgetConfig {
  return {
    contextWindowSize: resolved.contextWindowSize,
    preserveRecent: resolved.preserveRecent,
    tokenEstimator: resolved.tokenEstimator,
    softTriggerFraction: resolved.micro.triggerFraction,
    hardTriggerFraction: resolved.full.triggerFraction,
    microTargetFraction: resolved.micro.targetFraction,
    maxResultTokens: resolved.replacement.maxResultTokens,
    maxMessageTokens: resolved.replacement.maxMessageTokens,
    previewChars: resolved.replacement.previewChars,
    maxSummaryTokens: resolved.full.maxSummaryTokens,
  };
}

// ---------------------------------------------------------------------------
// Dropped-message computation
// ---------------------------------------------------------------------------

/**
 * Compute messages that were dropped by compaction.
 *
 * For a given split index, the "head" (messages before the split) are candidates
 * for dropping. Rescued pinned messages (and their pair partners) survive, so
 * the dropped set is: head - rescued.
 */
function computeDroppedMessages(
  allMessages: readonly InboundMessage[],
  splitIdx: number,
): readonly InboundMessage[] {
  if (splitIdx <= 0) return [];
  const rescued = new Set(rescuePinnedGroups(allMessages, splitIdx));
  const dropped: InboundMessage[] = []; // let: accumulator array built once
  for (let i = 0; i < splitIdx; i++) {
    const msg = allMessages[i];
    if (msg !== undefined && !rescued.has(msg)) {
      dropped.push(msg);
    }
  }
  return dropped;
}

/**
 * Compute messages dropped by micro-compaction by comparing the original
 * message array against the surviving messages (referential identity).
 */
function computeMicroDroppedMessages(
  original: readonly InboundMessage[],
  surviving: readonly InboundMessage[],
): readonly InboundMessage[] {
  const survivingSet = new Set(surviving);
  const dropped: InboundMessage[] = []; // let: accumulator array built once
  for (const msg of original) {
    if (!survivingSet.has(msg)) {
      dropped.push(msg);
    }
  }
  return dropped;
}

// ---------------------------------------------------------------------------
// Fallback estimator
// ---------------------------------------------------------------------------

const FALLBACK_ESTIMATOR: TokenEstimator = {
  estimateText(text: string): number {
    return Math.ceil(text.length / 4);
  },
  estimateMessages(messages: readonly InboundMessage[]): number {
    let total = 0; // let: accumulator
    for (const msg of messages) {
      total += 4;
      for (const block of msg.content) {
        if (block.kind === "text") {
          total += Math.ceil(block.text.length / 4);
        } else {
          total += 100;
        }
      }
    }
    return total;
  },
};

// ---------------------------------------------------------------------------
// Main orchestrator
// ---------------------------------------------------------------------------

/**
 * Enforce the token budget on a conversation turn.
 *
 * Replacement is NON-TERMINAL: after evaluating new tool results for
 * replacement, the cascade ALWAYS continues through the budget check
 * on the POST-INGESTION state (existing messages + new results as
 * previews or originals).
 *
 * Cleanup is NOT called — the caller must track all active refs across
 * the full conversation and call store.cleanup() themselves.
 *
 * @param messages — Current conversation messages.
 * @param store — Replacement store (or undefined to skip replacement).
 * @param config — Budget configuration (or undefined for defaults).
 * @param newToolResults — Tool result(s) to evaluate for replacement.
 */
export async function enforceBudget(
  messages: readonly InboundMessage[],
  store?: ReplacementStore,
  config?: BudgetConfig,
  newToolResults?: string | readonly string[],
): Promise<BudgetEnforcementResult> {
  const contextWindowSize = config?.contextWindowSize ?? COMPACTION_DEFAULTS.contextWindowSize;
  const preserveRecent = config?.preserveRecent ?? COMPACTION_DEFAULTS.preserveRecent;
  const estimator = config?.tokenEstimator ?? FALLBACK_ESTIMATOR;
  const softFraction = config?.softTriggerFraction ?? COMPACTION_DEFAULTS.micro.triggerFraction;
  const hardFraction = config?.hardTriggerFraction ?? COMPACTION_DEFAULTS.full.triggerFraction;
  const microTarget = config?.microTargetFraction ?? COMPACTION_DEFAULTS.micro.targetFraction;
  const maxResultTokens =
    config?.maxResultTokens ?? COMPACTION_DEFAULTS.replacement.maxResultTokens;
  const maxMessageTokens =
    config?.maxMessageTokens ?? COMPACTION_DEFAULTS.replacement.maxMessageTokens;
  const previewChars = config?.previewChars ?? COMPACTION_DEFAULTS.replacement.previewChars;
  const maxSummaryTokens = config?.maxSummaryTokens ?? COMPACTION_DEFAULTS.full.maxSummaryTokens;

  // Stage 1a: Estimate new tool-result tokens unconditionally (even without a store)
  let replacementInfo: ReplacementInfo | undefined;
  let newResultTokens = 0;

  if (newToolResults !== undefined) {
    const results = typeof newToolResults === "string" ? [newToolResults] : newToolResults;

    // Stage 1b: Content replacement (only when a ReplacementStore is configured)
    if (store !== undefined) {
      const messageOutcome = await evaluateMessageResults(results, store, {
        maxResultTokens,
        maxMessageTokens,
        previewChars,
        tokenEstimator: estimator,
      });

      const anyReplaced = messageOutcome.outcomes.some((o) => o.replaced);

      // Build previews array (replaced → preview, unreplaced → original)
      const previews = messageOutcome.outcomes.map((o, i) => {
        if (o.replaced) return o.preview;
        return results[i] ?? "";
      });

      // Compute token contribution of new results (post-replacement)
      for (let i = 0; i < previews.length; i++) {
        const text = previews[i];
        if (text !== undefined) {
          newResultTokens += await Promise.resolve(estimator.estimateText(text));
        }
      }

      if (anyReplaced) {
        replacementInfo = {
          previews,
          outcomes: messageOutcome.outcomes,
          tokensSaved: messageOutcome.totalSavedTokens,
          activeRefs: collectRefsFromOutcomes(messageOutcome.outcomes),
        };
      }
    } else {
      // No store — estimate raw result tokens for budget accounting
      for (const text of results) {
        newResultTokens += await Promise.resolve(estimator.estimateText(text));
      }
    }
  }

  // Stage 2: Estimate tokens on POST-INGESTION state
  // = existing messages + new tool results (as previews or originals)
  const existingTokens = await maybeAwait(estimator.estimateMessages(messages));
  const totalTokens = existingTokens + newResultTokens;

  // Stage 3: Policy decision on post-ingestion total
  const decision = shouldCompact(totalTokens, contextWindowSize, softFraction, hardFraction);

  if (decision === "noop") {
    return {
      compaction: "noop",
      messages,
      totalTokens,
      ...(replacementInfo !== undefined ? { replacement: replacementInfo } : {}),
    };
  }

  // Stage 4: Microcompact (operates on existing messages only —
  // new results haven't been ingested into the message array yet)
  // Reserve space for the incoming tool result so post-compaction + result fits.
  if (decision === "micro") {
    const targetTokens = Math.floor(contextWindowSize * microTarget) - newResultTokens;
    const result = await microcompact(messages, targetTokens, preserveRecent, estimator);

    // If micro-compaction met the target (post-compaction + result fits), return it.
    // Otherwise promote to full compaction.
    if (result.compactedTokens + newResultTokens <= Math.floor(contextWindowSize * microTarget)) {
      const droppedMessages = computeMicroDroppedMessages(messages, result.messages);

      // Fire onBeforeDrop callback before returning (gives caller a chance
      // to extract decision-relevant facts from the about-to-be-lost messages).
      // Fail-open: callback failure is surfaced via preservationFailed/Error
      // but must not prevent compaction from completing.
      let preservationFailed = false;
      let preservationError: unknown;
      if (droppedMessages.length > 0 && config?.onBeforeDrop !== undefined) {
        try {
          await Promise.resolve(config.onBeforeDrop(droppedMessages));
        } catch (e: unknown) {
          preservationFailed = true;
          preservationError = e;
        }
      }

      return {
        compaction: "micro",
        messages: result.messages,
        originalTokens: result.originalTokens,
        compactedTokens: result.compactedTokens,
        strategy: result.strategy,
        ...(replacementInfo !== undefined ? { replacement: replacementInfo } : {}),
        ...(droppedMessages.length > 0 ? { droppedMessages } : {}),
        ...(preservationFailed ? { preservationFailed, preservationError } : {}),
      };
    }
    // Fall through to full compaction
  }

  // Stage 5: Full compact — compute split, don't summarize
  // Reserve space for the incoming tool result in the split budget.
  const validSplitPoints = findValidSplitPoints(messages, preserveRecent);
  const splitIdx = await findOptimalSplit(
    messages,
    validSplitPoints,
    contextWindowSize - newResultTokens,
    maxSummaryTokens,
    estimator,
  );

  const droppedMessages = computeDroppedMessages(messages, splitIdx);

  // Fire onBeforeDrop callback before returning.
  // Fail-open: callback failure is surfaced via preservationFailed/Error
  // but must not prevent compaction from completing.
  let preservationFailed = false;
  let preservationError: unknown;
  if (droppedMessages.length > 0 && config?.onBeforeDrop !== undefined) {
    try {
      await Promise.resolve(config.onBeforeDrop(droppedMessages));
    } catch (e: unknown) {
      preservationFailed = true;
      preservationError = e;
    }
  }

  return {
    compaction: "full",
    messages,
    splitIdx,
    totalTokens,
    ...(replacementInfo !== undefined ? { replacement: replacementInfo } : {}),
    ...(droppedMessages.length > 0 ? { droppedMessages } : {}),
    ...(preservationFailed ? { preservationFailed, preservationError } : {}),
  };
}
