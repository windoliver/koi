/**
 * Soft warning threshold system with exactly-once semantics.
 *
 * Fires alerts at configurable percentage thresholds (e.g. 50%, 75%, 90%)
 * of a budget limit. Each threshold fires at most once per session.
 *
 * Design decisions (Decision 12A):
 * - Skip-over: if spend jumps from 40% → 80%, both 50% and 75% fire
 * - Re-crossing: if spend drops (correction) and re-crosses, does NOT re-fire
 * - Exact boundary: threshold at exactly 50.000...% fires
 * - Per-session isolation: threshold state is keyed by sessionId
 */

export interface ThresholdAlert {
  readonly sessionId: string;
  readonly threshold: number;
  readonly currentSpend: number;
  readonly budget: number;
  readonly percentage: number;
}

export interface ThresholdConfig {
  /** Budget limit in USD. */
  readonly budget: number;
  /** Threshold percentages (0-1). Default: [0.5, 0.75, 0.9]. */
  readonly thresholds?: readonly number[] | undefined;
  /** Called when a threshold is crossed. */
  readonly onAlert: (alert: ThresholdAlert) => void;
}

/** Default soft warning thresholds: 50%, 75%, 90%. */
export const DEFAULT_THRESHOLDS: readonly number[] = [0.5, 0.75, 0.9] as const;

export interface ThresholdTracker {
  /** Check thresholds after a cost update. Fires alerts for newly crossed thresholds. */
  readonly check: (sessionId: string, totalSpend: number) => void;
  /** Clear threshold state for a session. */
  readonly clearSession: (sessionId: string) => void;
}

/**
 * Create a threshold tracker with exactly-once alert semantics.
 *
 * Thresholds are sorted ascending. On each check(), all thresholds
 * at or below the current spend percentage fire (if not already fired).
 */
export function createThresholdTracker(config: ThresholdConfig): ThresholdTracker {
  const budget = config.budget;
  const thresholds = [...(config.thresholds ?? DEFAULT_THRESHOLDS)].sort((a, b) => a - b);
  const onAlert = config.onAlert;

  // Per-session: set of thresholds that have already fired
  const firedSessions = new Map<string, Set<number>>();

  function getFired(sessionId: string): Set<number> {
    const existing = firedSessions.get(sessionId);
    if (existing !== undefined) return existing;
    const fresh = new Set<number>();
    firedSessions.set(sessionId, fresh);
    return fresh;
  }

  return {
    check(sessionId: string, totalSpend: number): void {
      if (budget <= 0) return;

      const percentage = totalSpend / budget;
      const fired = getFired(sessionId);

      for (const threshold of thresholds) {
        if (percentage >= threshold && !fired.has(threshold)) {
          fired.add(threshold);
          onAlert({
            sessionId,
            threshold,
            currentSpend: totalSpend,
            budget,
            percentage,
          });
        }
      }
    },

    clearSession(sessionId: string): void {
      firedSessions.delete(sessionId);
    },
  };
}
