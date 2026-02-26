/**
 * Checkpoint timing policy — pure functions, no I/O.
 *
 * Determines when soft checkpoints should fire and generates
 * deterministic checkpoint identifiers.
 */

import type { HarnessId } from "@koi/core";

/**
 * Determine whether a soft checkpoint should fire at the given turn.
 *
 * Fires at every `interval`-th turn, starting from the first interval.
 * Turn 0 never triggers a checkpoint (session just started).
 */
export function shouldSoftCheckpoint(turnIndex: number, interval: number): boolean {
  if (turnIndex <= 0) return false;
  if (interval <= 0) return false;
  return turnIndex % interval === 0;
}

/**
 * Generate a deterministic checkpoint ID from harness, session, and turn.
 *
 * Format: `{harnessId}:{sessionId}:t{turnIndex}`
 */
export function computeCheckpointId(
  harnessId: HarnessId,
  sessionId: string,
  turnIndex: number,
): string {
  return `${harnessId}:${sessionId}:t${String(turnIndex)}`;
}
