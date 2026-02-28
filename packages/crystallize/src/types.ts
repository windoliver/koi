/**
 * Types for @koi/crystallize — pattern detection and crystallization candidates.
 */

import type { KoiError, KoiMiddleware, Result, TurnTrace } from "@koi/core";

// ---------------------------------------------------------------------------
// Tool step & n-gram
// ---------------------------------------------------------------------------

/** A single tool invocation in a sequence. */
export interface ToolStep {
  readonly toolId: string;
  /** Outcome of the tool call, derived from trace output. */
  readonly outcome?: "success" | "failure";
}

/** An ordered sequence of tool steps with a deduplication key. */
export interface ToolNgram {
  readonly steps: readonly ToolStep[];
  readonly key: string;
}

// ---------------------------------------------------------------------------
// Crystallization candidate
// ---------------------------------------------------------------------------

/** A detected repeating pattern surfaced for potential forging. */
export interface CrystallizationCandidate {
  readonly ngram: ToolNgram;
  readonly occurrences: number;
  readonly turnIndices: readonly number[];
  readonly detectedAt: number;
  readonly suggestedName: string;
  readonly score?: number;
}

// ---------------------------------------------------------------------------
// Config & handle
// ---------------------------------------------------------------------------

/** Configuration for the crystallize middleware factory. */
export interface CrystallizeConfig {
  readonly readTraces: () => Promise<Result<readonly TurnTrace[], KoiError>>;
  readonly minNgramSize?: number;
  readonly maxNgramSize?: number;
  readonly minOccurrences?: number;
  readonly maxCandidates?: number;
  readonly minTurnsBeforeAnalysis?: number;
  readonly analysisCooldownTurns?: number;
  readonly maxPatternAgeMs?: number;
  readonly clock?: () => number;
  readonly onCandidatesDetected: (candidates: readonly CrystallizationCandidate[]) => void;
}

/** Handle returned by the crystallize middleware factory. */
export interface CrystallizeHandle {
  readonly middleware: KoiMiddleware;
  readonly getCandidates: () => readonly CrystallizationCandidate[];
  readonly dismiss: (ngramKey: string) => void;
}
