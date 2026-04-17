/**
 * Closure-scoped state store for the strict-agentic middleware.
 *
 * Four maps:
 *   - turnStates:       `turnId -> TurnState` (populated in wrapModelCall /
 *                       wrapModelStream, read in onBeforeStop, cleared in
 *                       onAfterTurn).
 *   - turnToSession:    `turnId -> sessionId` reverse index so clearSession
 *                       can purge all outstanding turn entries for a session
 *                       that ends without onAfterTurn firing.
 *   - runBlockCounts:   `runId -> consecutive filler blocks` within that
 *                       outer run. Keyed by runId (stable per runtime.run()
 *                       call, new per call) so the counter naturally scopes
 *                       to one outer request and accumulates across engine
 *                       re-prompts within that request.
 *   - runToSession:     `runId -> sessionId` reverse index so clearSession
 *                       can purge any outstanding run counters for the
 *                       session.
 *
 * A new store is created per `createStrictAgenticMiddleware` call, so test
 * instances are isolated.
 */

export interface TurnState {
  readonly toolCallCount: number;
  readonly outputText: string;
}

export interface StateStore {
  readonly recordTurn: (sessionId: string, turnId: string, state: TurnState) => void;
  readonly readTurn: (turnId: string) => TurnState | undefined;
  readonly clearTurn: (turnId: string) => void;
  readonly incrementBlocks: (sessionId: string, runId: string) => number;
  readonly resetBlocks: (runId: string) => void;
  readonly getBlockCount: (runId: string) => number;
  readonly clearSession: (sessionId: string) => void;
}

export function createStateStore(): StateStore {
  const turnStates = new Map<string, TurnState>();
  const turnToSession = new Map<string, string>();
  const runBlockCounts = new Map<string, number>();
  const runToSession = new Map<string, string>();

  return {
    recordTurn(sessionId: string, turnId: string, state: TurnState): void {
      turnStates.set(turnId, state);
      turnToSession.set(turnId, sessionId);
    },
    readTurn(turnId: string): TurnState | undefined {
      return turnStates.get(turnId);
    },
    clearTurn(turnId: string): void {
      turnStates.delete(turnId);
      turnToSession.delete(turnId);
    },
    incrementBlocks(sessionId: string, runId: string): number {
      const next = (runBlockCounts.get(runId) ?? 0) + 1;
      runBlockCounts.set(runId, next);
      runToSession.set(runId, sessionId);
      return next;
    },
    resetBlocks(runId: string): void {
      runBlockCounts.delete(runId);
      runToSession.delete(runId);
    },
    getBlockCount(runId: string): number {
      return runBlockCounts.get(runId) ?? 0;
    },
    clearSession(sessionId: string): void {
      // Purge all turn entries for this session (onAfterTurn may never fire
      // on abnormal session end).
      for (const [turnId, sid] of turnToSession) {
        if (sid === sessionId) {
          turnStates.delete(turnId);
          turnToSession.delete(turnId);
        }
      }
      // Purge all run counters for this session.
      for (const [rid, sid] of runToSession) {
        if (sid === sessionId) {
          runBlockCounts.delete(rid);
          runToSession.delete(rid);
        }
      }
    },
  };
}
