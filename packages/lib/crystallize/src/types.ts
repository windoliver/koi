/**
 * Core types for `@koi/crystallize` — pattern detection over agent turn traces.
 *
 * Scope of this package is the detection core: extract repeating tool-call
 * sequences from `TurnTrace` events, dedupe via subsumption, score by
 * frequency / complexity / recency / success-rate. Middleware, forge bridges,
 * and auto-forge are out of scope here and live in sibling packages.
 */

import type { SessionId } from "@koi/core";

/**
 * A single tool invocation in a sequence. `outcome` is classified at trace
 * ingest time:
 *  - `"success"` — captured non-error output.
 *  - `"failure"` — explicit error / denied / quarantined / `ok:false` /
 *    truthy top-level `error` envelope.
 *  - `"validation"` — pre-execution validation reject (kind:"validation"
 *    or top-level/nested `code:"VALIDATION"`). Distinguished from
 *    `undefined` so validation-only patterns score against `successRate`
 *    instead of receiving a false-perfect 1.0.
 *  - `undefined` — no captured output (no signal at all).
 */
export interface ToolStep {
  readonly toolId: string;
  readonly outcome?: "success" | "failure" | "validation" | undefined;
}

/** An ordered sequence of tool steps with a stable deduplication key. */
export interface ToolNgram {
  readonly steps: readonly ToolStep[];
  readonly key: string;
}

/**
 * Composite identity for one occurrence of a pattern. `turnIndex` alone is
 * not unique across multi-session or multi-agent trace sets — every session
 * starts at turn 0 — so dedup and downstream reporting must use the full
 * `(sessionId, agentId, turnIndex)` triple.
 */
export interface TurnLocation {
  readonly sessionId: SessionId;
  readonly agentId: string;
  readonly turnIndex: number;
}

/**
 * Aggregated outcome statistics at the **occurrence** level.
 *
 * `withOutcome` counts every occurrence that produced *any* signal —
 * success, failure, *or* validation reject. Validation-only patterns are
 * therefore visible in the denominator: a workflow that has only ever
 * been rejected by validation gets `successes: 0, withOutcome: N` and
 * scores `0` on `successRate`, instead of being false-perfect at 1.0.
 *
 * An occurrence counts as `success` only when every signal-bearing step in
 * that occurrence succeeded — partial-step success is not enough. A 5-step
 * pattern that fails on the final side-effecting step is not a healthy
 * forge candidate even when 4/5 step calls succeeded.
 */
export interface OutcomeStats {
  /** Occurrences where every signal-bearing step succeeded. */
  readonly successes: number;
  /**
   * Occurrences with at least one signal-bearing step (success, failure, or
   * validation reject). Validation-only occurrences contribute to this
   * total so `successRate = successes / withOutcome` punishes never-
   * executed workflows.
   */
  readonly withOutcome: number;
}

/** N-gram occurrence record — n-gram plus per-occurrence locations and aggregated outcomes. */
export interface NgramEntry {
  readonly ngram: ToolNgram;
  readonly locations: readonly TurnLocation[];
  readonly outcomeStats: OutcomeStats;
  /**
   * Per-turn window start indices. A pattern can match multiple windows in
   * the same turn (e.g. `[a,b]` appears twice in `[a,b,c,a,b]`), and turn-
   * level coverage alone is insufficient for subsumption — the longer
   * pattern must cover each *concrete* window of the shorter, not merely
   * appear in the same turn. Key is the JSON-encoded composite location.
   */
  readonly windowsByTurn: ReadonlyMap<string, ReadonlySet<number>>;
}

/** A detected repeating pattern surfaced as a forge candidate. */
export interface CrystallizationCandidate {
  readonly ngram: ToolNgram;
  readonly occurrences: number;
  /**
   * Composite locations of every occurrence: `(sessionId, agentId, turnIndex)`
   * triples. Stable across multi-session input where turn numbers reset.
   */
  readonly locations: readonly TurnLocation[];
  readonly detectedAt: number;
  readonly suggestedName: string;
  /** Aggregated outcome stats across every occurrence — drives success-rate scoring. */
  readonly outcomeStats: OutcomeStats;
  /** Quality score — higher = better forge candidate. Computed by `computeCrystallizeScore`. */
  readonly score?: number | undefined;
  /**
   * Per-turn window start indices forwarded from `NgramEntry`. Subsumption
   * uses this to verify that a longer candidate covers every concrete
   * occurrence of a shorter one, not just the set of turns in which the
   * shorter appears. Optional only for hand-crafted test fixtures —
   * production candidates always carry this; absence is treated as
   * "occurrence coverage unknown" and disables subsumption.
   */
  readonly windowsByTurn?: ReadonlyMap<string, ReadonlySet<number>>;
}

/** Configuration for `detectPatterns`. */
export interface DetectPatternsConfig {
  /** Minimum n-gram length (inclusive). Default: 2. */
  readonly minNgramSize?: number | undefined;
  /** Maximum n-gram length (inclusive). Default: 5. */
  readonly maxNgramSize?: number | undefined;
  /** Minimum occurrences required to surface a candidate. Default: 3. */
  readonly minOccurrences?: number | undefined;
  /** Cap on returned candidates after sorting + filtering. Default: 5. */
  readonly maxCandidates?: number | undefined;
  /** Optional first-seen timestamps per n-gram key — drives recency decay across analysis cycles. */
  readonly firstSeenTimes?: ReadonlyMap<string, number> | undefined;
}

/** Configuration for `computeCrystallizeScore`. */
export interface ScoreConfig {
  /** Half-life for the recency-decay component, in milliseconds. Default: 30 minutes. */
  readonly recencyHalfLifeMs?: number | undefined;
}
