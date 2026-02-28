/**
 * Validation for CrystallizeConfig — ensures all numeric fields are sane
 * and resolves defaults for optional fields.
 */

import type { KoiError, Result } from "@koi/core";
import type { CrystallizeConfig } from "./types.js";

// ---------------------------------------------------------------------------
// Validated config type
// ---------------------------------------------------------------------------

/** Validated config with all defaults resolved. */
export interface ValidatedCrystallizeConfig {
  readonly readTraces: CrystallizeConfig["readTraces"];
  readonly minNgramSize: number;
  readonly maxNgramSize: number;
  readonly minOccurrences: number;
  readonly maxCandidates: number;
  readonly minTurnsBeforeAnalysis: number;
  readonly analysisCooldownTurns: number;
  readonly maxPatternAgeMs: number;
  readonly clock: () => number;
  readonly onCandidatesDetected: CrystallizeConfig["onCandidatesDetected"];
}

// ---------------------------------------------------------------------------
// Default values
// ---------------------------------------------------------------------------

const DEFAULT_MIN_NGRAM_SIZE = 2;
const DEFAULT_MAX_NGRAM_SIZE = 5;
const DEFAULT_MIN_OCCURRENCES = 3;
const DEFAULT_MAX_CANDIDATES = 5;
const DEFAULT_MIN_TURNS_BEFORE_ANALYSIS = 5;
const DEFAULT_ANALYSIS_COOLDOWN_TURNS = 3;
/** 1 hour */
const DEFAULT_MAX_PATTERN_AGE_MS = 3_600_000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function validationError(message: string): { readonly ok: false; readonly error: KoiError } {
  return {
    ok: false,
    error: {
      code: "VALIDATION",
      message,
      retryable: false,
    },
  };
}

// ---------------------------------------------------------------------------
// Validator
// ---------------------------------------------------------------------------

/**
 * Validate and resolve defaults for CrystallizeConfig.
 *
 * Returns a fully-resolved config on success or a VALIDATION error on failure.
 */
export function validateCrystallizeConfig(
  config: CrystallizeConfig,
): Result<ValidatedCrystallizeConfig, KoiError> {
  const minNgramSize = config.minNgramSize ?? DEFAULT_MIN_NGRAM_SIZE;
  const maxNgramSize = config.maxNgramSize ?? DEFAULT_MAX_NGRAM_SIZE;
  const minOccurrences = config.minOccurrences ?? DEFAULT_MIN_OCCURRENCES;
  const maxCandidates = config.maxCandidates ?? DEFAULT_MAX_CANDIDATES;
  const minTurnsBeforeAnalysis = config.minTurnsBeforeAnalysis ?? DEFAULT_MIN_TURNS_BEFORE_ANALYSIS;
  const analysisCooldownTurns = config.analysisCooldownTurns ?? DEFAULT_ANALYSIS_COOLDOWN_TURNS;
  const maxPatternAgeMs = config.maxPatternAgeMs ?? DEFAULT_MAX_PATTERN_AGE_MS;
  const clock = config.clock ?? Date.now;

  if (minNgramSize < 1) {
    return validationError(`minNgramSize must be >= 1, got ${String(minNgramSize)}`);
  }
  if (maxNgramSize < 1) {
    return validationError(`maxNgramSize must be >= 1, got ${String(maxNgramSize)}`);
  }
  if (minNgramSize > maxNgramSize) {
    return validationError(
      `minNgramSize (${String(minNgramSize)}) must be <= maxNgramSize (${String(maxNgramSize)})`,
    );
  }
  if (minOccurrences < 1) {
    return validationError(`minOccurrences must be >= 1, got ${String(minOccurrences)}`);
  }
  if (maxCandidates < 1) {
    return validationError(`maxCandidates must be >= 1, got ${String(maxCandidates)}`);
  }
  if (minTurnsBeforeAnalysis < 1) {
    return validationError(
      `minTurnsBeforeAnalysis must be >= 1, got ${String(minTurnsBeforeAnalysis)}`,
    );
  }
  if (analysisCooldownTurns < 0) {
    return validationError(
      `analysisCooldownTurns must be >= 0, got ${String(analysisCooldownTurns)}`,
    );
  }
  if (maxPatternAgeMs <= 0) {
    return validationError(`maxPatternAgeMs must be > 0, got ${String(maxPatternAgeMs)}`);
  }

  return {
    ok: true,
    value: {
      readTraces: config.readTraces,
      minNgramSize,
      maxNgramSize,
      minOccurrences,
      maxCandidates,
      minTurnsBeforeAnalysis,
      analysisCooldownTurns,
      maxPatternAgeMs,
      clock,
      onCandidatesDetected: config.onCandidatesDetected,
    },
  };
}
