import type { BackendDescriptor, BackendState, KoiError } from "@koi/core";
import type { MatchRejection } from "./match.js";

export interface SelectionAttempt {
  readonly adapter: string;
  readonly state: BackendState;
  readonly ok: boolean;
  readonly error?: KoiError;
}

export interface SelectionDecision {
  readonly selected: BackendDescriptor;
  readonly attempts: readonly SelectionAttempt[];
  readonly rejected: readonly MatchRejection[];
}

export interface BuildDecisionInput {
  readonly selected: BackendDescriptor;
  readonly attempts: readonly SelectionAttempt[];
  readonly rejected: readonly MatchRejection[];
}

/**
 * Build an immutable `SelectionDecision`. All nested arrays are frozen so
 * audit consumers cannot mutate the record after the router returns.
 */
export function buildDecision(input: BuildDecisionInput): SelectionDecision {
  return Object.freeze({
    selected: input.selected,
    attempts: Object.freeze([...input.attempts]),
    rejected: Object.freeze([...input.rejected]),
  });
}
