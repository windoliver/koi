/**
 * N-gram extraction over agent `TurnTrace` events.
 *
 * The detection pipeline walks turns, projects each turn down to an ordered
 * sequence of `ToolStep`s, then slides a window of size [min..max] over each
 * sequence to populate an immutable `Map<key, NgramEntry>`. Per-turn
 * deduplication ensures a pattern that occurs twice within the same turn is
 * counted as one occurrence (we score across-turn repetition, not within-turn
 * burst).
 */

import type { TurnTrace } from "@koi/core";
import type { NgramEntry, ToolNgram, ToolStep } from "./types.js";

/**
 * Infer outcome from a tool call's output. `undefined` (no result captured) is
 * treated as failure; objects with a truthy `error` field are failures; all
 * other shapes — including `null` (valid void return) — are successes.
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
 * Project each `TurnTrace` to an ordered sequence of `ToolStep`s by filtering
 * to `tool_call` events and preserving per-turn order.
 */
export function extractToolSequences(
  traces: readonly TurnTrace[],
): readonly (readonly ToolStep[])[] {
  return traces.map((trace) => {
    const steps: ToolStep[] = [];
    for (const event of trace.events) {
      if (event.event.kind === "tool_call") {
        steps.push({ toolId: event.event.toolId, outcome: inferOutcome(event.event.output) });
      }
    }
    return steps;
  });
}

/** Stable deduplication key for an n-gram — pipe-joined tool IDs. */
export function computeNgramKey(steps: readonly ToolStep[]): string {
  return steps.map((s) => s.toolId).join("|");
}

/**
 * Extract every n-gram of length `[minSize..maxSize]` from `sequences` via
 * sliding window. Returns a key→entry map; each entry records all turn
 * indices where the n-gram appeared (a single turn contributes at most one
 * occurrence per key, even if the pattern repeats within that turn).
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
          // Per-turn dedup: only record this turn once per key.
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
