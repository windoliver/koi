/**
 * Closure-scoped state store for the strict-agentic middleware.
 *
 * Three maps:
 *   - turnStates:         `turnId -> TurnState` (populated in wrapModelCall,
 *                         read in onBeforeStop, cleared in onAfterTurn).
 *   - turnToSession:      `turnId -> sessionId` reverse index so clearSession
 *                         can purge all outstanding turn entries for a session
 *                         that ends without `onAfterTurn` firing (cancellation,
 *                         crash, transport abort).
 *   - sessionBlockCounts: `sessionId -> consecutive filler blocks` (reset on
 *                         any non-filler turn, cleared on session end).
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
  readonly incrementBlocks: (sessionId: string) => number;
  readonly resetBlocks: (sessionId: string) => void;
  readonly getBlockCount: (sessionId: string) => number;
  readonly clearSession: (sessionId: string) => void;
}

export function createStateStore(): StateStore {
  const turnStates = new Map<string, TurnState>();
  const turnToSession = new Map<string, string>();
  const sessionBlockCounts = new Map<string, number>();

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
    incrementBlocks(sessionId: string): number {
      const next = (sessionBlockCounts.get(sessionId) ?? 0) + 1;
      sessionBlockCounts.set(sessionId, next);
      return next;
    },
    resetBlocks(sessionId: string): void {
      sessionBlockCounts.delete(sessionId);
    },
    getBlockCount(sessionId: string): number {
      return sessionBlockCounts.get(sessionId) ?? 0;
    },
    clearSession(sessionId: string): void {
      sessionBlockCounts.delete(sessionId);
      // Purge any turn entries that still point at this session. Protects
      // against onAfterTurn never firing (cancellation, crash) — without this
      // a stale turn could classify a later turn that happens to reuse an id.
      for (const [turnId, sid] of turnToSession) {
        if (sid === sessionId) {
          turnStates.delete(turnId);
          turnToSession.delete(turnId);
        }
      }
    },
  };
}
