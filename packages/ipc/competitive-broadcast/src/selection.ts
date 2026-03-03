/**
 * Selection strategies for competitive broadcast.
 *
 * Three built-in strategies: first-wins, scored, and consensus.
 * All return Result<Proposal, KoiError> — never throw.
 */

import type { KoiError, Result } from "@koi/core/errors";
import { RETRYABLE_DEFAULTS } from "@koi/core/errors";
import type { Proposal, SelectionStrategy, Vote } from "./types.js";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const EMPTY_ERROR: KoiError = {
  code: "VALIDATION",
  message: "Cannot select from empty proposals list",
  retryable: RETRYABLE_DEFAULTS.VALIDATION,
};

/** Sanitize a score: NaN and Infinity become 0. */
function sanitizeScore(score: number): number {
  if (!Number.isFinite(score)) return 0;
  return score;
}

// ---------------------------------------------------------------------------
// Tiebreaker: lowest submittedAt → highest salience → lexicographic id
// ---------------------------------------------------------------------------

function tiebreak(a: Proposal, b: Proposal): number {
  if (a.submittedAt !== b.submittedAt) return a.submittedAt - b.submittedAt;
  const salienceA = a.salience ?? 0;
  const salienceB = b.salience ?? 0;
  if (salienceA !== salienceB) return salienceB - salienceA; // higher salience wins
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Returns the first element of an array, or an error Result if the array is empty.
 * Satisfies noUncheckedIndexedAccess without non-null assertions.
 */
function firstOrError<T>(items: readonly T[]): Result<T, KoiError> {
  const first = items[0];
  if (first === undefined) return { ok: false, error: EMPTY_ERROR };
  return { ok: true, value: first };
}

// ---------------------------------------------------------------------------
// createFirstWinsSelector
// ---------------------------------------------------------------------------

/**
 * Picks the proposal with the lowest `submittedAt`.
 * Tiebreaker: highest salience, then lexicographic id.
 */
export function createFirstWinsSelector(): SelectionStrategy {
  return {
    name: "first-wins",
    select: (proposals: readonly Proposal[]): Result<Proposal, KoiError> => {
      if (proposals.length === 0) return { ok: false, error: EMPTY_ERROR };
      const sorted = [...proposals].sort(tiebreak);
      return firstOrError(sorted);
    },
  };
}

// ---------------------------------------------------------------------------
// createScoredSelector
// ---------------------------------------------------------------------------

/**
 * Picks the proposal with the highest score.
 * Default score = `salience ?? 0`. Custom `scoreFn` overrides.
 * NaN/Infinity scores are treated as 0.
 * Tiebreaker: lowest submittedAt → lexicographic id.
 */
export function createScoredSelector(scoreFn?: (proposal: Proposal) => number): SelectionStrategy {
  const score = scoreFn ?? ((p: Proposal): number => p.salience ?? 0);

  return {
    name: "scored",
    select: (proposals: readonly Proposal[]): Result<Proposal, KoiError> => {
      if (proposals.length === 0) return { ok: false, error: EMPTY_ERROR };

      const scored = proposals
        .map((p) => ({
          proposal: p,
          score: sanitizeScore(score(p)),
        }))
        .sort((a, b) => {
          if (a.score !== b.score) return b.score - a.score; // higher score wins
          return tiebreak(a.proposal, b.proposal);
        });

      const winner = firstOrError(scored);
      if (!winner.ok) return winner;
      return { ok: true, value: winner.value.proposal };
    },
  };
}

// ---------------------------------------------------------------------------
// createConsensusSelector
// ---------------------------------------------------------------------------

/** Options for consensus selection. */
export interface ConsensusOptions {
  /** Fraction of total vote score a proposal must reach to win. */
  readonly threshold: number;
  /** Async judge callback that evaluates proposals and returns votes. */
  readonly judge: (proposals: readonly Proposal[]) => Promise<readonly Vote[]>;
}

/**
 * Selects the proposal that exceeds a `threshold` fraction of total vote score.
 * Returns VALIDATION error if no proposal reaches consensus.
 */
export function createConsensusSelector(options: ConsensusOptions): SelectionStrategy {
  if (options.threshold < 0 || options.threshold > 1) {
    throw new RangeError(`Consensus threshold must be in [0, 1], got ${options.threshold}`);
  }

  return {
    name: "consensus",
    select: async (proposals: readonly Proposal[]): Promise<Result<Proposal, KoiError>> => {
      if (proposals.length === 0) return { ok: false, error: EMPTY_ERROR };

      const votes = await options.judge(proposals);

      // Build a map of proposalId → total score (only for known proposals)
      const proposalIds = new Set(proposals.map((p) => p.id));
      const scoreMap = new Map<string, number>();
      let totalScore = 0;

      for (const vote of votes) {
        if (!proposalIds.has(vote.proposalId)) continue;
        const current = scoreMap.get(vote.proposalId) ?? 0;
        const sanitized = sanitizeScore(vote.score);
        scoreMap.set(vote.proposalId, current + sanitized);
        totalScore += sanitized;
      }

      // Find the proposal with the highest fraction of total score
      if (totalScore === 0) {
        return {
          ok: false,
          error: {
            code: "VALIDATION",
            message: "No consensus reached: total vote score is zero",
            retryable: RETRYABLE_DEFAULTS.VALIDATION,
          },
        };
      }

      // Sort proposals by their fraction (descending), tiebreak by submittedAt
      const ranked = proposals
        .map((p) => ({
          proposal: p,
          fraction: (scoreMap.get(p.id) ?? 0) / totalScore,
        }))
        .sort((a, b) => {
          if (a.fraction !== b.fraction) return b.fraction - a.fraction;
          return tiebreak(a.proposal, b.proposal);
        });

      const bestResult = firstOrError(ranked);
      if (!bestResult.ok) return bestResult;
      const best = bestResult.value;

      if (best.fraction >= options.threshold) {
        return { ok: true, value: best.proposal };
      }

      return {
        ok: false,
        error: {
          code: "VALIDATION",
          message: `No consensus reached: best fraction ${best.fraction.toFixed(3)} < threshold ${options.threshold}`,
          retryable: RETRYABLE_DEFAULTS.VALIDATION,
          context: {
            bestProposalId: best.proposal.id,
            bestFraction: best.fraction,
            threshold: options.threshold,
          },
        },
      };
    },
  };
}
