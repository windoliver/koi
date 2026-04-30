/**
 * N-gram extraction over agent `TurnTrace` events.
 *
 * The detection pipeline walks turns, projects each turn down to an ordered
 * sequence of `ToolStep`s, then slides a window of size [min..max] over each
 * sequence to populate an immutable `Map<key, NgramEntry>`.
 *
 * Per-turn dedup uses the full `(sessionId, agentId, turnIndex)` triple
 * because turn numbers reset per session — keying on `turnIndex` alone would
 * silently merge unrelated occurrences across sessions or agents.
 *
 * Per-turn outcome folding: when a pattern matches multiple windows in the
 * same turn (e.g. `[a,b]` appearing twice within one turn), the turn's
 * verdict is a fold of all matching windows' step signals — *any* failed
 * window fails the turn, success requires at least one signal-bearing
 * window with no failures. This prevents a turn whose first window happened
 * to succeed from masking later failures in the same turn.
 */

import type { TurnTrace } from "@koi/core";
import type { NgramEntry, OutcomeStats, ToolNgram, ToolStep, TurnLocation } from "./types.js";

/**
 * Infer outcome from a tool call's output:
 *  - `undefined` (no captured output) → `undefined` (no signal).
 *  - Object payload with `kind: "error"` / `kind: "denied"` → failure
 *    (matches `agent-monitor.isErrorOutput` / `isDeniedOutput`).
 *  - Object payload with `kind: "validation"` or `code: "VALIDATION"` →
 *    `undefined` (pre-execution reject; neutral, must not skew successRate).
 *  - Anything else captured — primitives (`string`, `number`, `boolean`),
 *    `null`, plain objects without a known failure/validation envelope —
 *    counts as success. A tool that legitimately returns a primitive
 *    contributes positive health signal; treating those as `undefined`
 *    would silently zero out successRate for entire pattern classes.
 */
function inferOutcome(output: unknown): "success" | "failure" | undefined {
  if (output === undefined) return undefined;
  if (output !== null && typeof output === "object") {
    const obj = output as { readonly kind?: unknown; readonly code?: unknown };
    if (obj.kind === "error" || obj.kind === "denied") return "failure";
    if (obj.kind === "validation" || obj.code === "VALIDATION") return undefined;
  }
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

/**
 * One turn's projected tool steps paired with the source trace's composite
 * occurrence identity. Carrying the full `(sessionId, agentId, turnIndex)`
 * tuple keeps occurrence dedup correct across multi-session input.
 */
export interface TurnSequence {
  readonly location: TurnLocation;
  readonly steps: readonly ToolStep[];
}

/**
 * Project each `TurnTrace` to an ordered sequence of `ToolStep`s alongside
 * its composite identity. Mixing traces from multiple sessions or agents is
 * supported because the identity carries enough information to keep their
 * occurrences disjoint.
 */
export function extractToolSequences(traces: readonly TurnTrace[]): readonly TurnSequence[] {
  return traces.map((trace) => ({
    location: { sessionId: trace.sessionId, agentId: trace.agentId, turnIndex: trace.turnIndex },
    steps: projectTurn(trace),
  }));
}

/**
 * Escape `\` and `|` in a tool id so that pipe-joined keys remain unambiguous
 * even when tool ids contain the separator. Without escaping, the IDs
 * `["a|b", "c"]` and `["a", "b|c"]` would both produce the key `"a|b|c"` and
 * collide in the n-gram map.
 */
function escapeToolId(id: string): string {
  return id.replace(/\\/g, "\\\\").replace(/\|/g, "\\|");
}

/** Stable deduplication key for an n-gram — pipe-joined, pipe-escaped tool IDs. */
export function computeNgramKey(steps: readonly ToolStep[]): string {
  return steps.map((s) => escapeToolId(s.toolId)).join("|");
}

interface MutableEntry {
  readonly ngram: ToolNgram;
  readonly locations: TurnLocation[];
  /** Composite identity of the turn currently being aggregated, or null. */
  pendingLocKey: string | null;
  /** Whether any window matched in the pending turn carried outcome signal. */
  pendingHadSignal: boolean;
  /** Whether any window matched in the pending turn carried a failure. */
  pendingHadFailure: boolean;
  /** Committed occurrence-level counts across already-finalized turns. */
  successes: number;
  withOutcome: number;
}

function locationKey(loc: TurnLocation): string {
  // Trace-level metadata is opaque to this package; serialize to an
  // unambiguous composite key. JSON keeps quoting + escaping for free and
  // avoids ad-hoc separator collisions.
  return JSON.stringify([loc.sessionId, loc.agentId, loc.turnIndex]);
}

function windowSignal(steps: readonly ToolStep[]): { signal: boolean; failure: boolean } {
  let signal = false;
  let failure = false;
  for (const step of steps) {
    if (step.outcome === undefined) continue;
    signal = true;
    if (step.outcome === "failure") failure = true;
  }
  return { signal, failure };
}

function commitPending(entry: MutableEntry): void {
  if (entry.pendingLocKey === null) return;
  if (entry.pendingHadSignal) {
    entry.withOutcome += 1;
    if (!entry.pendingHadFailure) entry.successes += 1;
  }
  entry.pendingLocKey = null;
  entry.pendingHadSignal = false;
  entry.pendingHadFailure = false;
}

function freezeEntry(entry: MutableEntry): NgramEntry {
  // Final commit at extraction end; safe to do once per entry.
  commitPending(entry);
  const stats: OutcomeStats = { successes: entry.successes, withOutcome: entry.withOutcome };
  return { ngram: entry.ngram, locations: entry.locations, outcomeStats: stats };
}

/**
 * Extract every n-gram of length `[minSize..maxSize]` from `sequences` via
 * sliding window. Returns a key→entry map; each entry records all turn
 * locations where the n-gram appeared (one location per turn-with-pattern,
 * even if the pattern repeats within that turn) and an aggregated
 * `OutcomeStats` over per-occurrence verdicts (a turn is successful only if
 * every matching window in that turn succeeded).
 */
export function extractNgrams(
  sequences: readonly TurnSequence[],
  minSize: number,
  maxSize: number,
): ReadonlyMap<string, NgramEntry> {
  const accum = new Map<string, MutableEntry>();

  for (const { location, steps: seq } of sequences) {
    const locKey = locationKey(location);
    for (let size = minSize; size <= maxSize; size++) {
      for (let start = 0; start <= seq.length - size; start++) {
        const steps = seq.slice(start, start + size);
        const key = computeNgramKey(steps);
        const { signal, failure } = windowSignal(steps);
        let entry = accum.get(key);
        if (entry === undefined) {
          entry = {
            ngram: { steps, key },
            locations: [location],
            pendingLocKey: locKey,
            pendingHadSignal: signal,
            pendingHadFailure: failure,
            successes: 0,
            withOutcome: 0,
          };
          accum.set(key, entry);
          continue;
        }
        if (entry.pendingLocKey === locKey) {
          // Same turn — fold this window's signal into the pending verdict.
          // Conservative rule: any failed window fails the turn; success
          // requires at least one signal-bearing window with zero failures.
          entry.pendingHadSignal = entry.pendingHadSignal || signal;
          entry.pendingHadFailure = entry.pendingHadFailure || failure;
          continue;
        }
        // New turn — commit the previous turn's verdict, record the new
        // occurrence location, start a fresh pending bucket.
        commitPending(entry);
        entry.locations.push(location);
        entry.pendingLocKey = locKey;
        entry.pendingHadSignal = signal;
        entry.pendingHadFailure = failure;
      }
    }
  }

  const result = new Map<string, NgramEntry>();
  for (const [key, entry] of accum) result.set(key, freezeEntry(entry));
  return result;
}
