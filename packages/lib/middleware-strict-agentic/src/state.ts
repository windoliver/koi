/**
 * Closure-scoped state store for the strict-agentic middleware.
 *
 * Two maps, both keyed by runId:
 *   - runTurnStates:    `runId -> latest TurnState` from the most recent
 *                       wrapModelCall / wrapModelStream observation. The
 *                       engine mints different turnIds for the model-call
 *                       and the stop-gate contexts, so the middleware
 *                       cannot key by turnId — the key is the outer runId
 *                       (stable across all model calls + stop-gate checks
 *                       inside one runtime.run()).
 *   - runBlockCounts:   `runId -> consecutive filler blocks` within that
 *                       outer run.
 *
 * Both maps are purged on clearSession (via a sessionId→runIds reverse
 * index) so an abnormal session end does not leak state.
 *
 * A new store is created per createStrictAgenticMiddleware call; tests are
 * isolated.
 */

export interface TurnState {
  readonly toolCallCount: number;
  readonly outputText: string;
}

export interface StateStore {
  readonly recordTurn: (sessionId: string, runId: string, state: TurnState) => void;
  readonly readTurn: (runId: string) => TurnState | undefined;
  readonly clearTurn: (runId: string) => void;
  readonly incrementBlocks: (sessionId: string, runId: string) => number;
  readonly resetBlocks: (runId: string) => void;
  readonly getBlockCount: (runId: string) => number;
  readonly clearSession: (sessionId: string) => void;
}

export function createStateStore(): StateStore {
  const runTurnStates = new Map<string, TurnState>();
  const runBlockCounts = new Map<string, number>();
  const runToSession = new Map<string, string>();

  return {
    recordTurn(sessionId: string, runId: string, state: TurnState): void {
      runTurnStates.set(runId, state);
      runToSession.set(runId, sessionId);
    },
    readTurn(runId: string): TurnState | undefined {
      return runTurnStates.get(runId);
    },
    clearTurn(runId: string): void {
      runTurnStates.delete(runId);
      // Don't clear runToSession here — the run counter may still be live.
    },
    incrementBlocks(sessionId: string, runId: string): number {
      const next = (runBlockCounts.get(runId) ?? 0) + 1;
      runBlockCounts.set(runId, next);
      runToSession.set(runId, sessionId);
      return next;
    },
    resetBlocks(runId: string): void {
      runBlockCounts.delete(runId);
    },
    getBlockCount(runId: string): number {
      return runBlockCounts.get(runId) ?? 0;
    },
    clearSession(sessionId: string): void {
      // Purge every run entry that pointed at this session.
      for (const [rid, sid] of runToSession) {
        if (sid === sessionId) {
          runTurnStates.delete(rid);
          runBlockCounts.delete(rid);
          runToSession.delete(rid);
        }
      }
    },
  };
}
