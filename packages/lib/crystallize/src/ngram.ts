/**
 * N-gram extraction over agent `TurnTrace` events.
 *
 * The detection pipeline walks turns, projects each turn down to an ordered
 * sequence of `ToolStep`s, then slides a window of size [min..max] over each
 * sequence to populate an immutable `Map<key, NgramEntry>`. Per-turn
 * deduplication ensures a pattern that occurs twice within the same turn is
 * counted as one occurrence (we score across-turn repetition, not within-turn
 * burst). Step-level outcome counts are aggregated across every occurrence so
 * downstream success-rate scoring reflects the full pattern history rather
 * than a single representative window.
 */

import type { TurnTrace } from "@koi/core";
import type { NgramEntry, OutcomeStats, ToolNgram, ToolStep } from "./types.js";

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

interface MutableEntry {
  readonly ngram: ToolNgram;
  readonly turnIndices: number[];
  successes: number;
  withOutcome: number;
}

function accumulateStepOutcomes(entry: MutableEntry, steps: readonly ToolStep[]): void {
  for (const step of steps) {
    if (step.outcome === undefined) continue;
    entry.withOutcome += 1;
    if (step.outcome === "success") entry.successes += 1;
  }
}

function freezeEntry(entry: MutableEntry): NgramEntry {
  const stats: OutcomeStats = { successes: entry.successes, withOutcome: entry.withOutcome };
  return { ngram: entry.ngram, turnIndices: entry.turnIndices, outcomeStats: stats };
}

/**
 * Extract every n-gram of length `[minSize..maxSize]` from `sequences` via
 * sliding window. Returns a key→entry map; each entry records all turn
 * indices where the n-gram appeared (a single turn contributes at most one
 * occurrence per key, even if the pattern repeats within that turn) and an
 * aggregated `OutcomeStats` summed across every occurrence's step outcomes.
 */
export function extractNgrams(
  sequences: readonly (readonly ToolStep[])[],
  minSize: number,
  maxSize: number,
): ReadonlyMap<string, NgramEntry> {
  const accum = new Map<string, MutableEntry>();

  for (let turnIndex = 0; turnIndex < sequences.length; turnIndex++) {
    const seq = sequences[turnIndex];
    if (seq === undefined) continue;

    for (let size = minSize; size <= maxSize; size++) {
      for (let start = 0; start <= seq.length - size; start++) {
        const steps = seq.slice(start, start + size);
        const key = computeNgramKey(steps);
        const existing = accum.get(key);
        if (existing === undefined) {
          const entry: MutableEntry = {
            ngram: { steps, key },
            turnIndices: [turnIndex],
            successes: 0,
            withOutcome: 0,
          };
          accumulateStepOutcomes(entry, steps);
          accum.set(key, entry);
          continue;
        }
        // Per-turn dedup of the turn-indices list, but always aggregate
        // outcomes — every occurrence contributes its step-level signal.
        const indices = existing.turnIndices;
        if (indices[indices.length - 1] !== turnIndex) indices.push(turnIndex);
        accumulateStepOutcomes(existing, steps);
      }
    }
  }

  const result = new Map<string, NgramEntry>();
  for (const [key, entry] of accum) result.set(key, freezeEntry(entry));
  return result;
}
