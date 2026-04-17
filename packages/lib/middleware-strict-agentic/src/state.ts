/**
 * Closure-scoped state store for the strict-agentic middleware.
 *
 * Two independent Maps:
 *   - turnStates: `turnId -> TurnState` (populated in wrapModelCall, read in onBeforeStop,
 *     cleared in onAfterTurn).
 *   - sessionBlockCounts: `sessionId -> consecutive filler blocks` (reset on any non-filler
 *     turn, cleared on session end).
 *
 * A new store is created per `createStrictAgenticMiddleware` call, so test instances are
 * isolated.
 */

export interface TurnState {
  readonly toolCallCount: number;
  readonly outputText: string;
}

export interface StateStore {
  readonly recordTurn: (turnId: string, state: TurnState) => void;
  readonly readTurn: (turnId: string) => TurnState | undefined;
  readonly clearTurn: (turnId: string) => void;
  readonly incrementBlocks: (sessionId: string) => number;
  readonly resetBlocks: (sessionId: string) => void;
  readonly getBlockCount: (sessionId: string) => number;
  readonly clearSession: (sessionId: string) => void;
}

export function createStateStore(): StateStore {
  const turnStates = new Map<string, TurnState>();
  const sessionBlockCounts = new Map<string, number>();

  return {
    recordTurn(turnId: string, state: TurnState): void {
      turnStates.set(turnId, state);
    },
    readTurn(turnId: string): TurnState | undefined {
      return turnStates.get(turnId);
    },
    clearTurn(turnId: string): void {
      turnStates.delete(turnId);
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
    },
  };
}
