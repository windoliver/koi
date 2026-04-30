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
 * Infer outcome from a tool call's output, matching the repo's existing
 * tool-failure semantics (`agent-monitor.isErrorOutput` /
 * `isDeniedOutput`): only the explicit `kind: "error"` and `kind: "denied"`
 * envelopes mark a real execution failure. Any other payload — including
 * `null`, primitives, plain objects with a non-failure `error` field (e.g.
 * web-fetch's structured error result), or output where capture is missing —
 * yields `undefined`, meaning "no outcome signal" rather than "failure". This
 * prevents non-failure responses from systematically demoting healthy
 * patterns through `successRate`.
 */
function inferOutcome(output: unknown): "success" | "failure" | undefined {
  if (output === null || typeof output !== "object") return undefined;
  if (!("kind" in output)) return "success";
  const kind = (output as { readonly kind?: unknown }).kind;
  if (kind === "error" || kind === "denied") return "failure";
  return "success";
}

/** Project a single `TurnTrace` to an ordered sequence of `ToolStep`s. */
function projectTurn(trace: TurnTrace): readonly ToolStep[] {
  const steps: ToolStep[] = [];
  for (const event of trace.events) {
    if (event.event.kind === "tool_call") {
      steps.push({ toolId: event.event.toolId, outcome: inferOutcome(event.event.output) });
    }
  }
  return steps;
}

/** A turn's projected tool steps paired with the trace's real `turnIndex`. */
export interface TurnSequence {
  readonly turnIndex: number;
  readonly steps: readonly ToolStep[];
}

/**
 * Project each `TurnTrace` to an ordered sequence of `ToolStep`s alongside
 * the original `TurnTrace.turnIndex`. Preserving the real turn id keeps
 * downstream `turnIndices` stable when callers analyze sliced or
 * non-contiguous trace subsets.
 */
export function extractToolSequences(traces: readonly TurnTrace[]): readonly TurnSequence[] {
  return traces.map((trace) => ({ turnIndex: trace.turnIndex, steps: projectTurn(trace) }));
}

/** Stable deduplication key for an n-gram — pipe-joined tool IDs. */
export function computeNgramKey(steps: readonly ToolStep[]): string {
  return steps.map((s) => s.toolId).join("|");
}

interface MutableEntry {
  readonly ngram: ToolNgram;
  readonly turnIndices: number[];
  /** Count of occurrences where every signal-bearing step succeeded. */
  successes: number;
  /** Count of occurrences with at least one signal-bearing step. */
  withOutcome: number;
}

/** Classify one occurrence's whole-pattern outcome from its step-level signals. */
function occurrenceOutcome(steps: readonly ToolStep[]): "success" | "failure" | undefined {
  let sawSignal = false;
  for (const step of steps) {
    if (step.outcome === undefined) continue;
    sawSignal = true;
    if (step.outcome === "failure") return "failure";
  }
  return sawSignal ? "success" : undefined;
}

function recordOccurrence(entry: MutableEntry, steps: readonly ToolStep[]): void {
  const verdict = occurrenceOutcome(steps);
  if (verdict === undefined) return;
  entry.withOutcome += 1;
  if (verdict === "success") entry.successes += 1;
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
  sequences: readonly TurnSequence[],
  minSize: number,
  maxSize: number,
): ReadonlyMap<string, NgramEntry> {
  const accum = new Map<string, MutableEntry>();

  for (const { turnIndex, steps: seq } of sequences) {
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
          recordOccurrence(entry, steps);
          accum.set(key, entry);
          continue;
        }
        // Per-turn dedup: only the first window match in a given turn
        // counts as a new occurrence. Frequency and outcome aggregation use
        // the same unit (turns containing the pattern), so a retry storm
        // inside one turn cannot inflate or distort the score.
        const indices = existing.turnIndices;
        if (indices[indices.length - 1] === turnIndex) continue;
        indices.push(turnIndex);
        recordOccurrence(existing, steps);
      }
    }
  }

  const result = new Map<string, NgramEntry>();
  for (const [key, entry] of accum) result.set(key, freezeEntry(entry));
  return result;
}
