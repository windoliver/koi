/**
 * Mock SessionContext and TurnContext factories with sensible defaults
 * and deep overrides.
 */

import type { SessionContext, TurnContext } from "@koi/core";
import { runId, sessionId, turnId } from "@koi/core";

const DEFAULT_AGENT_ID = "test-agent";
const DEFAULT_SESSION = sessionId("test-session");
const DEFAULT_RUN = runId("test-run");

export function createMockSessionContext(overrides?: Partial<SessionContext>): SessionContext {
  return {
    agentId: DEFAULT_AGENT_ID,
    sessionId: DEFAULT_SESSION,
    runId: DEFAULT_RUN,
    metadata: {},
    ...overrides,
  };
}

export type MockTurnContextOverrides = Omit<Partial<TurnContext>, "session"> & {
  readonly session?: Partial<SessionContext>;
};

export function createMockTurnContext(overrides?: MockTurnContextOverrides): TurnContext {
  const session = createMockSessionContext(overrides?.session);
  const turnIndex = overrides?.turnIndex ?? 0;

  const base: TurnContext = {
    session,
    turnIndex,
    turnId: turnId(session.runId, turnIndex),
    messages: [],
    metadata: {},
  };

  if (overrides === undefined) {
    return base;
  }

  // Spread overrides last so explicit fields win, but skip the `session` key
  // (we already merged it into the constructed session above).
  const { session: _ignore, ...rest } = overrides;
  return { ...base, ...rest };
}
