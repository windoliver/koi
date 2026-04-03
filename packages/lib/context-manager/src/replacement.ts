/**
 * Content replacement — replace large tool results with previews.
 *
 * Pre-ingestion: evaluates each tool result before it enters the
 * conversation history. Large results are stored in a ReplacementStore
 * and replaced with a compact preview + retrieval reference.
 *
 * This is independent of compaction (which operates post-accumulation).
 * The two compose as a cascade: replacement → compaction.
 */

import { createHash } from "node:crypto";
import type { TokenEstimator } from "@koi/core";
import type { ReplacementRef, ReplacementStore } from "@koi/core/replacement";
import { replacementRef } from "@koi/core/replacement";
import { COMPACTION_DEFAULTS } from "./types.js";

// ---------------------------------------------------------------------------
// Replacement result
// ---------------------------------------------------------------------------

/** Outcome of evaluating a single tool result for replacement. */
export type ReplacementOutcome =
  | { readonly replaced: false }
  | {
      readonly replaced: true;
      readonly preview: string;
      readonly ref: ReplacementRef;
      readonly originalTokens: number;
      readonly previewTokens: number;
    };

// ---------------------------------------------------------------------------
// Preview generation
// ---------------------------------------------------------------------------

/**
 * Generate a preview from large content.
 *
 * Format (Claude Code pattern):
 * ```
 * [Large result: 45,231 chars, ~11,308 tokens]
 * Preview (first 2,048 chars):
 * <first previewChars of content>
 * ...
 * [Full content stored as ref:<hash>. Use retrieval tool to access.]
 * ```
 */
export function generatePreview(
  content: string,
  ref: ReplacementRef,
  previewChars: number,
  estimatedTokens: number,
): string {
  const truncated = content.slice(0, previewChars);
  const lines = [
    `[Large result: ${content.length.toLocaleString()} chars, ~${estimatedTokens.toLocaleString()} tokens]`,
    `Preview (first ${previewChars.toLocaleString()} chars):`,
    truncated,
    "...",
    `[Full content stored as ref:${ref}. Use retrieval tool to access.]`,
  ];
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// In-memory store implementation
// ---------------------------------------------------------------------------

/**
 * Create a content-addressed in-memory ReplacementStore.
 *
 * Uses SHA-256 hex digest as the reference key. Identical content
 * always produces the same ref (free deduplication).
 *
 * For Phase 1 / testing. Production callers should inject a
 * filesystem or cloud-backed store.
 */
export function createInMemoryReplacementStore(): ReplacementStore {
  const store = new Map<string, string>();

  return {
    put(content: string): ReplacementRef {
      const hash = createHash("sha256").update(content).digest("hex");
      const ref = replacementRef(hash);
      store.set(hash, content);
      return ref;
    },

    get(ref: ReplacementRef): string | undefined {
      return store.get(ref);
    },

    cleanup(activeRefs: ReadonlySet<ReplacementRef>): void {
      for (const key of store.keys()) {
        if (!activeRefs.has(replacementRef(key))) {
          store.delete(key);
        }
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Default estimator for standalone usage
// ---------------------------------------------------------------------------

const CHARS_PER_TOKEN_FAST_PATH = 4;

/** Inline fallback estimator (4 chars/token). Used when no estimator is provided. */
const FALLBACK_ESTIMATOR: TokenEstimator = {
  estimateText(text: string): number {
    return Math.ceil(text.length / CHARS_PER_TOKEN_FAST_PATH);
  },
  estimateMessages(): number {
    return 0; // Not used by replacement — only estimateText is called
  },
};

// ---------------------------------------------------------------------------
// Core replacement logic
// ---------------------------------------------------------------------------

/** Config accepted by evaluateReplacement and evaluateMessageResults. */
export interface ReplacementEvalConfig {
  readonly maxResultTokens?: number;
  readonly maxMessageTokens?: number;
  readonly previewChars?: number;
  readonly tokenEstimator?: TokenEstimator;
}

/**
 * Evaluate whether a tool result needs replacement and, if so,
 * store the original and return a preview.
 *
 * Fast path: results smaller than `maxResultTokens * 4` chars are
 * skipped without calling the estimator (conservative — 4 chars/token
 * is the most generous ratio, so if it's under, any real tokenizer
 * will also say it's under).
 *
 * @param content — The raw tool result content.
 * @param store — Where to persist replaced content.
 * @param config — Replacement config including optional TokenEstimator.
 * @returns ReplacementOutcome indicating whether replacement occurred.
 */
export function evaluateReplacement(
  content: string,
  store: ReplacementStore,
  config?: ReplacementEvalConfig,
): ReplacementOutcome | Promise<ReplacementOutcome> {
  const maxResultTokens =
    config?.maxResultTokens ?? COMPACTION_DEFAULTS.replacement.maxResultTokens;
  const previewChars = config?.previewChars ?? COMPACTION_DEFAULTS.replacement.previewChars;
  const estimator = config?.tokenEstimator ?? FALLBACK_ESTIMATOR;

  // Always consult the configured estimator — a pre-estimator short-circuit
  // is unsafe because pluggable estimators can count more tokens per char
  // than the 4-chars/token heuristic (e.g. charEstimator: 1 char = 1 token).
  const estimateResult = estimator.estimateText(content);

  // Handle async estimator
  if (estimateResult instanceof Promise) {
    return estimateResult.then((estimatedTokens) =>
      doReplacement(content, store, previewChars, maxResultTokens, estimatedTokens),
    );
  }

  return doReplacement(content, store, previewChars, maxResultTokens, estimateResult);
}

/**
 * Internal: perform replacement after token estimation.
 */
function doReplacement(
  content: string,
  store: ReplacementStore,
  previewChars: number,
  maxResultTokens: number,
  estimatedTokens: number,
): ReplacementOutcome | Promise<ReplacementOutcome> {
  if (estimatedTokens <= maxResultTokens) {
    return { replaced: false };
  }

  const putResult = store.put(content);

  if (putResult instanceof Promise) {
    return putResult.then((ref) =>
      buildReplacementOutcome(content, ref, previewChars, estimatedTokens),
    );
  }

  return buildReplacementOutcome(content, putResult, previewChars, estimatedTokens);
}

/**
 * Internal: build a replacement outcome from a stored ref.
 */
function buildReplacementOutcome(
  content: string,
  ref: ReplacementRef,
  previewChars: number,
  estimatedTokens: number,
): ReplacementOutcome {
  const preview = generatePreview(content, ref, previewChars, estimatedTokens);
  return {
    replaced: true,
    preview,
    ref,
    originalTokens: estimatedTokens,
    previewTokens: Math.ceil(preview.length / CHARS_PER_TOKEN_FAST_PATH),
  };
}

/**
 * Evaluate all tool results in a message and replace any that exceed
 * the per-result threshold. Also enforces the per-message aggregate cap.
 *
 * Returns the outcomes for each result and total token savings.
 */
export async function evaluateMessageResults(
  contents: readonly string[],
  store: ReplacementStore,
  config?: ReplacementEvalConfig,
): Promise<ReplacementMessageOutcome> {
  const maxMessageTokens =
    config?.maxMessageTokens ?? COMPACTION_DEFAULTS.replacement.maxMessageTokens;
  const maxResultTokens =
    config?.maxResultTokens ?? COMPACTION_DEFAULTS.replacement.maxResultTokens;
  const previewChars = config?.previewChars ?? COMPACTION_DEFAULTS.replacement.previewChars;
  const estimator = config?.tokenEstimator ?? FALLBACK_ESTIMATOR;

  // First pass: evaluate each result individually, resolving any async outcomes
  const rawOutcomes = contents.map((content) =>
    evaluateReplacement(content, store, {
      maxResultTokens,
      previewChars,
      tokenEstimator: estimator,
    }),
  );
  const outcomes = await Promise.all(rawOutcomes.map((o) => Promise.resolve(o)));

  return buildMessageOutcome(outcomes, contents, maxMessageTokens, store, previewChars, estimator);
}

/** Outcome of evaluating all tool results in a single message. */
export interface ReplacementMessageOutcome {
  readonly outcomes: readonly ReplacementOutcome[];
  readonly totalSavedTokens: number;
  readonly aggregateCapApplied: boolean;
}

/**
 * Estimate tokens for a text string using the configured estimator.
 * Handles sync/async transparently.
 */
async function estimateText(text: string, estimator: TokenEstimator): Promise<number> {
  return Promise.resolve(estimator.estimateText(text));
}

/**
 * Build the final message outcome, applying the per-message aggregate cap
 * if necessary. Replaces largest-first to free the most tokens per replacement.
 *
 * Uses the configured TokenEstimator for all token accounting.
 * Fully async-aware: awaits store.put() and estimator calls.
 */
async function buildMessageOutcome(
  outcomes: readonly ReplacementOutcome[],
  contents: readonly string[],
  maxMessageTokens: number,
  store: ReplacementStore,
  previewChars: number,
  estimator: TokenEstimator,
): Promise<ReplacementMessageOutcome> {
  // Compute actual total tokens from outcomes using real estimator
  let totalTokens = 0; // let: accumulator
  for (let i = 0; i < outcomes.length; i++) {
    const outcome = outcomes[i];
    if (outcome === undefined) continue;
    if (outcome.replaced) {
      totalTokens += await estimateText(outcome.preview, estimator);
    } else {
      const content = contents[i];
      if (content !== undefined) {
        totalTokens += await estimateText(content, estimator);
      }
    }
  }

  // If under aggregate cap, return as-is
  if (totalTokens <= maxMessageTokens) {
    let savedTokens = 0; // let: accumulator
    for (const o of outcomes) {
      if (o.replaced) {
        savedTokens += o.originalTokens - o.previewTokens;
      }
    }
    return {
      outcomes,
      totalSavedTokens: savedTokens,
      aggregateCapApplied: false,
    };
  }

  // Over aggregate cap: replace additional results, largest first
  const mutableOutcomes = [...outcomes];
  let aggregateCapApplied = false; // let: flag

  // Build list of unreplaced results sorted by estimated size (largest first)
  const unreplaced: Array<{ readonly idx: number; readonly tokens: number }> = [];
  for (let i = 0; i < mutableOutcomes.length; i++) {
    const outcome = mutableOutcomes[i];
    if (outcome !== undefined && !outcome.replaced) {
      const content = contents[i];
      if (content !== undefined) {
        const tokens = await estimateText(content, estimator);
        unreplaced.push({ idx: i, tokens });
      }
    }
  }
  unreplaced.sort((a, b) => b.tokens - a.tokens);

  for (const { idx, tokens: contentTokens } of unreplaced) {
    if (totalTokens <= maxMessageTokens) break;
    const content = contents[idx];
    if (content === undefined) continue;

    const ref = await Promise.resolve(store.put(content));
    const preview = generatePreview(content, ref, previewChars, contentTokens);
    const previewTokens = await estimateText(preview, estimator);

    mutableOutcomes[idx] = {
      replaced: true,
      preview,
      ref,
      originalTokens: contentTokens,
      previewTokens,
    };

    totalTokens -= contentTokens - previewTokens;
    aggregateCapApplied = true;
  }

  let savedTokens = 0; // let: accumulator
  for (const o of mutableOutcomes) {
    if (o?.replaced) {
      savedTokens += o.originalTokens - o.previewTokens;
    }
  }

  return {
    outcomes: mutableOutcomes,
    totalSavedTokens: savedTokens,
    aggregateCapApplied,
  };
}

// ---------------------------------------------------------------------------
// Ref collection — format-agnostic
// ---------------------------------------------------------------------------

/**
 * Collect all replacement refs from a set of outcomes.
 *
 * This is the format-agnostic alternative to regex-based ref extraction.
 * Callers track which outcomes produced refs and pass them to store.cleanup().
 */
export function collectRefsFromOutcomes(
  outcomes: readonly ReplacementOutcome[],
): ReadonlySet<ReplacementRef> {
  const refs = new Set<ReplacementRef>();
  for (const outcome of outcomes) {
    if (outcome.replaced) {
      refs.add(outcome.ref);
    }
  }
  return refs;
}

// ---------------------------------------------------------------------------
// Ref extraction from surviving messages
// ---------------------------------------------------------------------------

/** Pattern matching `ref:<hex-hash>` in preview text. */
const REF_PATTERN = /\bref:([0-9a-f]{64})\b/g;

/**
 * Extract replacement refs from message text content.
 *
 * Scans for `ref:<sha256-hex>` patterns embedded in preview strings.
 * Use this to build the active ref set from surviving conversation messages
 * before calling `store.cleanup()` — ensures refs from older turns that
 * survived compaction are not prematurely deleted.
 *
 * @param texts — Message text contents to scan (e.g. from conversation history).
 * @returns Set of replacement refs found in the text.
 */
export function extractRefsFromTexts(texts: readonly string[]): ReadonlySet<ReplacementRef> {
  const refs = new Set<ReplacementRef>();
  for (const text of texts) {
    for (const m of text.matchAll(REF_PATTERN)) {
      const hash = m[1];
      if (hash !== undefined) {
        refs.add(replacementRef(hash));
      }
    }
  }
  return refs;
}
