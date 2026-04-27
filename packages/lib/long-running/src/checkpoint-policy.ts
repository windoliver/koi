/** Pure helpers for soft-checkpoint timing. */

/** True iff a soft checkpoint should run for this turn count. */
export function shouldSoftCheckpoint(turnCount: number, intervalTurns: number): boolean {
  if (intervalTurns <= 0) return false;
  if (turnCount <= 0) return false;
  return turnCount % intervalTurns === 0;
}

/** Stable id for a soft checkpoint, useful for log correlation. */
export function computeCheckpointId(
  harnessId: string,
  sessionId: string,
  turnCount: number,
): string {
  return `${harnessId}:${sessionId}:${turnCount}`;
}
