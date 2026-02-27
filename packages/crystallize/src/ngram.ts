/**
 * N-gram extraction from tool call traces.
 *
 * Extracts ordered tool ID sequences from TurnTrace events, then
 * generates all n-grams of configurable length via sliding window.
 */

import type { TurnTrace } from "@koi/core";
import type { ToolNgram, ToolStep } from "./types.js";

// ---------------------------------------------------------------------------
// Sequence extraction
// ---------------------------------------------------------------------------

/**
 * Extract ordered tool ID sequences from turn traces.
 * Filters to `tool_call` events and preserves per-turn order.
 */
export function extractToolSequences(
  traces: readonly TurnTrace[],
): readonly (readonly ToolStep[])[] {
  return traces.map((trace) => {
    const steps: ToolStep[] = [];
    for (const event of trace.events) {
      if (event.event.kind === "tool_call") {
        // justified: mutable local array being constructed, not shared state
        steps.push({ toolId: event.event.toolId });
      }
    }
    return steps;
  });
}

// ---------------------------------------------------------------------------
// N-gram generation
// ---------------------------------------------------------------------------

/** Compute a stable deduplication key for an n-gram. */
export function computeNgramKey(steps: readonly ToolStep[]): string {
  return steps.map((s) => s.toolId).join("|");
}

/**
 * Extract all n-grams from tool sequences via sliding window.
 * Returns a map of n-gram key → { ngram, turnIndices }.
 */
export function extractNgrams(
  sequences: readonly (readonly ToolStep[])[],
  minSize: number,
  maxSize: number,
): ReadonlyMap<string, { readonly ngram: ToolNgram; readonly turnIndices: readonly number[] }> {
  const result = new Map<string, { readonly ngram: ToolNgram; readonly turnIndices: number[] }>();

  for (let turnIndex = 0; turnIndex < sequences.length; turnIndex++) {
    const seq = sequences[turnIndex];
    if (seq === undefined) continue;

    for (let size = minSize; size <= maxSize; size++) {
      for (let start = 0; start <= seq.length - size; start++) {
        const steps = seq.slice(start, start + size);
        const key = computeNgramKey(steps);
        const existing = result.get(key);
        if (existing !== undefined) {
          // Only add turn index if not already recorded for this turn
          const indices = existing.turnIndices;
          if (indices[indices.length - 1] !== turnIndex) {
            result.set(key, {
              ngram: existing.ngram,
              turnIndices: [...indices, turnIndex],
            });
          }
        } else {
          result.set(key, {
            ngram: { steps, key },
            turnIndices: [turnIndex],
          });
        }
      }
    }
  }

  return result;
}
