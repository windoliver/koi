/**
 * Pure state-machine transition function for @koi/loop.
 *
 * No I/O, no timers, no abort wiring — just: given the current phase and
 * observed outcome, what do we do next? The main loop owns the side effects;
 * this file owns the decisions.
 *
 * Transition precedence (highest first):
 *   1. aborted flag       → terminal "aborted"
 *   2. runtime error      → terminal "errored"    (iterating phase only)
 *   3. token budget       → terminal "exhausted"  (HARD CAP — before convergence)
 *   4. verifier ok        → terminal "converged"
 *   5. circuit breaker    → terminal "circuit_broken"
 *   6. iteration budget   → terminal "exhausted"
 *   7. otherwise          → continue
 *
 * Rationale for precedence:
 * - Abort is the user's explicit command; always wins.
 * - Runtime error means we don't trust any other signal from this iteration.
 * - Token budget is a hard spend ceiling; even a passing verifier cannot
 *   override an overspent budget. If the user cared about cost, they said so.
 * - Convergence is the happy path; if it's reached under budget, nothing
 *   else matters.
 * - Circuit breaker before iteration budget: if the agent has failed N times
 *   in a row, "stuck" is a more useful diagnosis than "ran out of tries".
 */

import type { LoopStatus, TokenBudget, VerifierResult } from "./types.js";

// ---------------------------------------------------------------------------
// Inputs & outputs
// ---------------------------------------------------------------------------

export type LoopPhase = "iterating" | "verifying";

export interface TransitionConfig {
  readonly maxIterations: number;
  readonly maxBudgetTokens: TokenBudget;
  readonly maxConsecutiveFailures: number;
}

export interface TransitionInput {
  readonly phase: LoopPhase;
  /** 1-indexed iteration that just completed. */
  readonly iteration: number;
  /** Consecutive failure count *before* incorporating verifierResult. */
  readonly consecutiveFailures: number;
  readonly tokensConsumed: TokenBudget;
  readonly config: TransitionConfig;
  /** Populated in the `verifying` phase; undefined if phase is `iterating` and errored. */
  readonly verifierResult: VerifierResult | undefined;
  /** Populated in the `iterating` phase if runtime.run failed. */
  readonly runtimeError: string | undefined;
  /** True if the external abort signal fired. */
  readonly aborted: boolean;
}

type Transition =
  | {
      readonly kind: "continue";
      readonly nextIteration: number;
      readonly nextConsecutiveFailures: number;
    }
  | {
      readonly kind: "terminal";
      readonly status: LoopStatus;
      readonly reason: string;
    };

// ---------------------------------------------------------------------------
// Transition function
// ---------------------------------------------------------------------------

export function nextTransition(input: TransitionInput): Transition {
  // 1. Abort always wins.
  if (input.aborted) {
    return { kind: "terminal", status: "aborted", reason: "external abort signal fired" };
  }

  // 2. Runtime errored — verifier is not trusted / not called.
  if (input.phase === "iterating" && input.runtimeError !== undefined) {
    return {
      kind: "terminal",
      status: "errored",
      reason: `runtime error: ${input.runtimeError}`,
    };
  }

  // From here on we must be in `verifying` with a result.
  if (input.phase !== "verifying" || input.verifierResult === undefined) {
    throw new Error(
      `nextTransition: invalid input — phase=${input.phase}, verifierResult=${
        input.verifierResult === undefined ? "undefined" : "present"
      }`,
    );
  }

  const result = input.verifierResult;

  // 3. Token budget — HARD CAP. Checked BEFORE convergence so that a
  //    single iteration that blows past maxBudgetTokens cannot still
  //    report "converged" even if the verifier passed on that iteration.
  //    The user set a spend ceiling; we respect it even when the goal
  //    was otherwise met on the same turn.
  if (
    typeof input.config.maxBudgetTokens === "number" &&
    typeof input.tokensConsumed === "number" &&
    input.tokensConsumed >= input.config.maxBudgetTokens
  ) {
    return {
      kind: "terminal",
      status: "exhausted",
      reason: `maxBudgetTokens=${input.config.maxBudgetTokens} reached (consumed=${input.tokensConsumed})`,
    };
  }

  // 4. Convergence.
  if (result.ok) {
    return {
      kind: "terminal",
      status: "converged",
      reason: `verifier passed on iteration ${input.iteration}`,
    };
  }

  // 5. Circuit breaker (pure counter, no text comparison).
  const newConsecutive = input.consecutiveFailures + 1;
  if (newConsecutive >= input.config.maxConsecutiveFailures) {
    return {
      kind: "terminal",
      status: "circuit_broken",
      reason: `maxConsecutiveFailures=${input.config.maxConsecutiveFailures} reached`,
    };
  }

  // 6. Iteration budget.
  if (input.iteration >= input.config.maxIterations) {
    return {
      kind: "terminal",
      status: "exhausted",
      reason: `maxIterations=${input.config.maxIterations} reached`,
    };
  }

  // 7. Continue.
  return {
    kind: "continue",
    nextIteration: input.iteration + 1,
    nextConsecutiveFailures: newConsecutive,
  };
}
