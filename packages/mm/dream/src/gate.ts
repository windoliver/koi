/**
 * Dream gate — determines whether a dream consolidation should run.
 *
 * Pure function with no side effects. The actual scheduling/locking
 * is handled by the caller (scheduler, daemon, or CLI).
 */

import type { DreamGateState } from "./types.js";
import { DREAM_DEFAULTS } from "./types.js";

/**
 * Returns true if dream consolidation should run based on gate state.
 *
 * Both conditions must be met:
 * 1. Enough time has elapsed since last dream (default: 24h)
 * 2. Enough sessions have touched memory since last dream (default: 5)
 */
export function shouldDream(
  state: DreamGateState,
  options?: {
    readonly minTimeSinceLastDreamMs?: number;
    readonly minSessionsSinceLastDream?: number;
    readonly now?: number;
  },
): boolean {
  const now = options?.now ?? Date.now();
  const minTime = options?.minTimeSinceLastDreamMs ?? DREAM_DEFAULTS.minTimeSinceLastDreamMs;
  const minSessions =
    options?.minSessionsSinceLastDream ?? DREAM_DEFAULTS.minSessionsSinceLastDream;

  const timeSinceLast = now - state.lastDreamAt;
  const timeGate = timeSinceLast >= minTime;
  const sessionGate = state.sessionsSinceDream >= minSessions;

  return timeGate && sessionGate;
}
