/**
 * N-gram extraction from tool call traces.
 *
 * Extracts ordered tool ID sequences from TurnTrace events, then
 * generates all n-grams of configurable length via sliding window.
 * Supports both full recomputation and incremental updates.
 */

import type { TurnTrace } from "@koi/core";
import type { ToolNgram, ToolStep } from "./types.js";

// ---------------------------------------------------------------------------
// N-gram entry type
// ---------------------------------------------------------------------------

/** N-gram entry with occurrence tracking. */
export interface NgramEntry {
  readonly ngram: ToolNgram;
  readonly turnIndices: readonly number[];
}

// ---------------------------------------------------------------------------
// Sequence extraction
// ---------------------------------------------------------------------------

/**
 * Infer outcome from a tool call's output.
 * Undefined output indicates missing result (failure). Null is treated as
 * a valid void return (success). Objects with a truthy `error` field are failures.
 */
function inferOutcome(output: unknown): "success" | "failure" {
  if (output === undefined) return "failure";
  if (typeof output === "object" && output !== null && "error" in output) {
    const obj = output as Readonly<Record<string, unknown>>;
    if (obj.error) return "failure";
  }
  return "success";
}

/**
 * Extract ordered tool ID sequences from turn traces.
 * Filters to `tool_call` events and preserves per-turn order.
 * Populates outcome from tool call output for downstream scoring.
 */
export function extractToolSequences(
  traces: readonly TurnTrace[],
): readonly (readonly ToolStep[])[] {
  return traces.map((trace) => {
    const steps: ToolStep[] = [];
    for (const event of trace.events) {
      if (event.event.kind === "tool_call") {
        const outcome = inferOutcome(event.event.output);
        // justified: mutable local array being constructed, not shared state
        steps.push({ toolId: event.event.toolId, outcome });
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
 * Returns a map of n-gram key -> { ngram, turnIndices }.
 */
export function extractNgrams(
  sequences: readonly (readonly ToolStep[])[],
  minSize: number,
  maxSize: number,
): ReadonlyMap<string, NgramEntry> {
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

// ---------------------------------------------------------------------------
// Incremental n-gram extraction
// ---------------------------------------------------------------------------

/**
 * Incrementally extract n-grams from new sequences, merging into existing map.
 * Returns a new immutable map (does not mutate existing).
 *
 * @param newSequences - Tool step sequences from newly observed turns
 * @param startTurnIndex - Global turn index of the first new sequence
 * @param existing - Previously computed n-gram map to merge into
 * @param minSize - Minimum n-gram size
 * @param maxSize - Maximum n-gram size
 */
export function extractNgramsIncremental(
  newSequences: readonly (readonly ToolStep[])[],
  startTurnIndex: number,
  existing: ReadonlyMap<string, NgramEntry>,
  minSize: number,
  maxSize: number,
): ReadonlyMap<string, NgramEntry> {
  const result = new Map<string, { readonly ngram: ToolNgram; readonly turnIndices: number[] }>();

  // Copy existing entries (immutable — new map, not mutation)
  for (const [key, entry] of existing) {
    result.set(key, { ngram: entry.ngram, turnIndices: [...entry.turnIndices] });
  }

  // Process new sequences only
  for (let i = 0; i < newSequences.length; i++) {
    const turnIndex = startTurnIndex + i;
    const seq = newSequences[i];
    if (seq === undefined) continue;

    for (let size = minSize; size <= maxSize; size++) {
      for (let start = 0; start <= seq.length - size; start++) {
        const steps = seq.slice(start, start + size);
        const key = computeNgramKey(steps);
        const existingEntry = result.get(key);
        if (existingEntry !== undefined) {
          const indices = existingEntry.turnIndices;
          if (indices[indices.length - 1] !== turnIndex) {
            result.set(key, {
              ngram: existingEntry.ngram,
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
