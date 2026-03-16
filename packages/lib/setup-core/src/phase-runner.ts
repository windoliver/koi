/**
 * Phase runner — executes a sequence of async phases with progress callbacks.
 *
 * Returns on first failure with the phase ID in the error.
 */

import type { OperationError, OperationResult, PhaseCallbacks, PhaseDefinition } from "./types.js";

/**
 * Run a sequence of phases, calling callbacks at each lifecycle point.
 *
 * Stops on the first failure and returns the error with phase context.
 */
export async function runPhases<TContext>(
  phases: readonly PhaseDefinition<TContext>[],
  context: TContext,
  callbacks: PhaseCallbacks,
): Promise<OperationResult<void>> {
  for (const phase of phases) {
    callbacks.onPhaseStart(phase.id, phase.label);

    try {
      await phase.execute(context, (message: string) => {
        callbacks.onPhaseProgress(phase.id, message);
      });
      callbacks.onPhaseDone(phase.id);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      callbacks.onPhaseFailed(phase.id, message);

      const error: OperationError = {
        code: "PHASE_FAILED",
        message: `Phase "${phase.label}" failed: ${message}`,
        phase: phase.id,
        cause: err,
      };
      return { ok: false, error };
    }
  }

  return { ok: true, value: undefined };
}
