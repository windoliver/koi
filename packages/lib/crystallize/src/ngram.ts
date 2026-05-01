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
 * True when `error` carries a nested `{ code: "VALIDATION" }` envelope — the
 * LSP / repo-wide structured-validation-reject shape.
 */
function isNestedValidation(error: unknown): boolean {
  if (error === null || typeof error !== "object") return false;
  return (error as { readonly code?: unknown }).code === "VALIDATION";
}

/** True when `value` is a non-empty error indicator (truthy, not `false`/`""`/`null`). */
function isNonEmptyError(value: unknown): boolean {
  if (value === undefined || value === null || value === false || value === "") return false;
  return true;
}

/**
 * True when the response carries any of the canonical denial / error markers
 * that downstream observers (`@koi/event-trace`, `@koi/middleware-report`,
 * `@koi/session-transcript`) honour. Soft-deny responses from
 * `middleware-permissions` set `metadata.blockedByHook = true` (and
 * `permissionDenied` for #1650). Hook-side errors set `metadata.isError =
 * true`. Without this check a denied tool with a primitive `output` string
 * would be misclassified as success and produce false-positive forge
 * candidates for blocked workflows.
 */
function hasDenialMetadata(metadata: unknown): boolean {
  if (metadata === null || typeof metadata !== "object") return false;
  const m = metadata as {
    readonly blockedByHook?: unknown;
    readonly permissionDenied?: unknown;
    readonly isError?: unknown;
  };
  return m.blockedByHook === true || m.permissionDenied === true || m.isError === true;
}

/** True when `value` looks like a thrown JavaScript error preserved into the trace. */
function isErrorLike(value: unknown): boolean {
  if (value instanceof Error) return true;
  if (value === null || typeof value !== "object") return false;
  const v = value as {
    readonly name?: unknown;
    readonly message?: unknown;
    readonly stack?: unknown;
  };
  // Plain serialized Error: has `message` plus typically `name` or `stack`.
  return (
    typeof v.message === "string" && (typeof v.name === "string" || typeof v.stack === "string")
  );
}

/**
 * Infer outcome from a tool call's output. Aligns with the broader repo
 * failure taxonomy so denied, blocked, validation, or generic-error
 * payloads cannot be misclassified as healthy:
 *
 *  - `undefined` (no captured output) → `undefined` (no signal).
 *  - `kind: "error"`, `kind: "denied"`, `kind: "forge_tool_quarantined"`
 *    → failure.
 *  - `kind: "validation"` / top-level `code: "VALIDATION"` / nested
 *    `error.code: "VALIDATION"` → `validation` (pre-execution reject).
 *    Distinct from `undefined` so a validation-only pattern is visible in
 *    `OutcomeStats.withOutcome` and scores `0` on successRate.
 *  - `ok: false` (without a validation envelope) → failure.
 *  - Truthy top-level `error` field → failure. Hook-blocked tool calls
 *    surface as `output: { error: ... }`, and tool-side error envelopes
 *    (web-fetch SSRF blocks, etc.) carry the same shape; treating these
 *    as success would crystallize denied workflows.
 *  - Primitives, `null`, plain objects without any of the above → success.
 */
function inferOutcome(output: unknown): "success" | "failure" | "validation" | undefined {
  if (output === undefined) return undefined;
  if (isErrorLike(output)) return "failure";
  if (output === null || typeof output !== "object") return "success";

  const obj = output as {
    readonly kind?: unknown;
    readonly code?: unknown;
    readonly ok?: unknown;
    readonly error?: unknown;
    readonly metadata?: unknown;
  };

  if (obj.kind === "error" || obj.kind === "denied" || obj.kind === "forge_tool_quarantined") {
    return "failure";
  }
  if (obj.kind === "validation" || obj.code === "VALIDATION" || isNestedValidation(obj.error)) {
    return "validation";
  }
  if (obj.ok === false) return "failure";
  if (isNonEmptyError(obj.error)) return "failure";
  // Soft-deny / hook-blocked responses have a primitive output string and
  // surface failure only via metadata flags. Inspect last so non-denied
  // responses with unrelated metadata fields aren't misclassified.
  if (hasDenialMetadata(obj.metadata)) return "failure";
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

function traceLocationKey(trace: TurnTrace): string {
  return JSON.stringify([trace.sessionId, trace.agentId, trace.turnIndex]);
}

/**
 * Project each `TurnTrace` to an ordered sequence of `ToolStep`s alongside
 * its composite identity. Mixing traces from multiple sessions or agents is
 * supported because the identity carries enough information to keep their
 * occurrences disjoint.
 *
 * Traces with the same composite location `(sessionId, agentId, turnIndex)`
 * are treated as duplicates of one occurrence and deduplicated to the first
 * one seen. Replayed snapshots, merged trace windows, and persisted-state
 * round-trips can all surface the same turn twice; without this dedup the
 * extractor would inflate `occurrences` and cross `minOccurrences`
 * spuriously, since the package's stable occurrence identity is precisely
 * that composite tuple.
 */
export function extractToolSequences(traces: readonly TurnTrace[]): readonly TurnSequence[] {
  const seen = new Set<string>();
  const out: TurnSequence[] = [];
  for (const trace of traces) {
    const key = traceLocationKey(trace);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      location: { sessionId: trace.sessionId, agentId: trace.agentId, turnIndex: trace.turnIndex },
      steps: projectTurn(trace),
    });
  }
  return out;
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
  /**
   * For each turn the pattern matched, the set of window start indices in
   * that turn. A pattern can match more than once per turn; subsumption
   * needs concrete window offsets, not just turn membership, to avoid
   * deleting a shorter pattern whose extra in-turn occurrences fall
   * outside any longer pattern's window.
   */
  readonly windowsByTurn: Map<string, Set<number>>;
  /** Composite identity of the turn currently being aggregated, or null. */
  pendingLocKey: string | null;
  /** Whether any window in the pending turn had an explicit success step. */
  pendingHadSuccess: boolean;
  /** Whether any window in the pending turn had an explicit failure step. */
  pendingHadFailure: boolean;
  /** Whether any window in the pending turn had a validation-reject step. */
  pendingHadValidation: boolean;
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

function windowSignal(steps: readonly ToolStep[]): {
  success: boolean;
  failure: boolean;
  validation: boolean;
} {
  let success = false;
  let failure = false;
  let validation = false;
  for (const step of steps) {
    if (step.outcome === "success") success = true;
    else if (step.outcome === "failure") failure = true;
    else if (step.outcome === "validation") validation = true;
  }
  return { success, failure, validation };
}

/**
 * Commit the pending turn's verdict to the entry's running counts. An
 * occurrence is recorded against `withOutcome` whenever it carried any
 * signal — success, failure, or validation reject — so validation-only
 * patterns score `0` on successRate instead of receiving a false-perfect
 * 1.0 from the no-signal default.
 */
function commitPending(entry: MutableEntry): void {
  if (entry.pendingLocKey === null) return;
  const hadAnySignal =
    entry.pendingHadSuccess || entry.pendingHadFailure || entry.pendingHadValidation;
  if (hadAnySignal) {
    entry.withOutcome += 1;
    // Success requires explicit success, no failure, and no validation
    // reject. Validation-only or failure-tainted turns count as denominator
    // but not numerator.
    if (entry.pendingHadSuccess && !entry.pendingHadFailure && !entry.pendingHadValidation) {
      entry.successes += 1;
    }
  }
  entry.pendingLocKey = null;
  entry.pendingHadSuccess = false;
  entry.pendingHadFailure = false;
  entry.pendingHadValidation = false;
}

function freezeEntry(entry: MutableEntry): NgramEntry {
  // Final commit at extraction end; safe to do once per entry.
  commitPending(entry);
  const stats: OutcomeStats = { successes: entry.successes, withOutcome: entry.withOutcome };
  return {
    ngram: entry.ngram,
    locations: entry.locations,
    outcomeStats: stats,
    windowsByTurn: entry.windowsByTurn,
  };
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
        const { success, failure, validation } = windowSignal(steps);
        let entry = accum.get(key);
        if (entry === undefined) {
          entry = {
            ngram: { steps, key },
            locations: [location],
            windowsByTurn: new Map([[locKey, new Set([start])]]),
            pendingLocKey: locKey,
            pendingHadSuccess: success,
            pendingHadFailure: failure,
            pendingHadValidation: validation,
            successes: 0,
            withOutcome: 0,
          };
          accum.set(key, entry);
          continue;
        }
        // Always record the window's start index for this turn — even on
        // repeat matches within the same turn — so subsumption can compare
        // concrete occurrences, not just turn membership.
        let turnWindows = entry.windowsByTurn.get(locKey);
        if (turnWindows === undefined) {
          turnWindows = new Set<number>();
          entry.windowsByTurn.set(locKey, turnWindows);
        }
        turnWindows.add(start);
        if (entry.pendingLocKey === locKey) {
          // Same turn — fold this window's signals into the pending verdict.
          // Failure / validation taint the whole turn; success only counts
          // when no failure or validation appeared in any window.
          entry.pendingHadSuccess = entry.pendingHadSuccess || success;
          entry.pendingHadFailure = entry.pendingHadFailure || failure;
          entry.pendingHadValidation = entry.pendingHadValidation || validation;
          continue;
        }
        // New turn — commit the previous turn's verdict, record the new
        // occurrence location, start a fresh pending bucket.
        commitPending(entry);
        entry.locations.push(location);
        entry.pendingLocKey = locKey;
        entry.pendingHadSuccess = success;
        entry.pendingHadFailure = failure;
        entry.pendingHadValidation = validation;
      }
    }
  }

  const result = new Map<string, NgramEntry>();
  for (const [key, entry] of accum) result.set(key, freezeEntry(entry));
  return result;
}
