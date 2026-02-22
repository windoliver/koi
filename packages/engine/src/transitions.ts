/**
 * State machine transition validation and CAS application.
 *
 * Uses VALID_TRANSITIONS from @koi/core (L0) to enforce the architecture-doc
 * state machine. All operations are pure — no side effects, no mutation.
 */

import type { AgentStatus, KoiError, ProcessState, Result, TransitionReason } from "@koi/core";
import { VALID_TRANSITIONS } from "@koi/core";

// ---------------------------------------------------------------------------
// Transition input
// ---------------------------------------------------------------------------

/** Input for a CAS state transition. */
export interface TransitionInput {
  readonly from: ProcessState;
  readonly to: ProcessState;
  readonly expectedGeneration: number;
  readonly reason: TransitionReason;
}

// ---------------------------------------------------------------------------
// Validation (pure — checks edges only)
// ---------------------------------------------------------------------------

/**
 * Validate that a transition from `from` to `to` is allowed by the
 * architecture-doc state machine. Does NOT check CAS generation.
 */
export function validateTransition(from: ProcessState, to: ProcessState): Result<void, KoiError> {
  const allowed = VALID_TRANSITIONS[from];
  if (!allowed.some((s) => s === to)) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: `Invalid transition: ${from} → ${to}. Allowed from ${from}: [${allowed.join(", ")}]`,
        retryable: false,
      },
    };
  }
  return { ok: true, value: undefined };
}

// ---------------------------------------------------------------------------
// CAS application (pure — returns new status, never mutates)
// ---------------------------------------------------------------------------

/**
 * Apply a state transition with CAS (compare-and-swap) semantics.
 *
 * Checks:
 * 1. Current phase matches `input.from` (phase CAS)
 * 2. Current generation matches `input.expectedGeneration` (version CAS)
 * 3. Transition is valid per VALID_TRANSITIONS
 *
 * Returns a new AgentStatus on success, or a typed error on failure.
 */
export function applyTransition(
  current: AgentStatus,
  input: TransitionInput,
): Result<AgentStatus, KoiError> {
  // CAS check: phase must match expected
  if (current.phase !== input.from) {
    return {
      ok: false,
      error: {
        code: "CONFLICT",
        message: `Phase mismatch: expected ${input.from}, current is ${current.phase}`,
        retryable: true,
      },
    };
  }

  // CAS check: generation must match expected
  if (current.generation !== input.expectedGeneration) {
    return {
      ok: false,
      error: {
        code: "CONFLICT",
        message: `Stale generation: expected ${String(input.expectedGeneration)}, current is ${String(current.generation)}`,
        retryable: true,
      },
    };
  }

  // Validate the transition edge
  const valid = validateTransition(input.from, input.to);
  if (!valid.ok) {
    return valid;
  }

  // Apply: return new immutable status
  const newStatus: AgentStatus = {
    phase: input.to,
    generation: current.generation + 1,
    conditions: [...current.conditions],
    reason: input.reason,
    lastTransitionAt: Date.now(),
  };

  return { ok: true, value: newStatus };
}
