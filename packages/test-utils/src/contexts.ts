/**
 * Mock context factories for middleware testing.
 */

import type { JsonObject } from "@koi/core/common";
import type { InboundMessage } from "@koi/core/message";
import type { SessionContext, TurnContext } from "@koi/core/middleware";

export function createMockSessionContext(overrides?: Partial<SessionContext>): SessionContext {
  return {
    agentId: "agent-test-1",
    sessionId: "session-test-1",
    metadata: {},
    ...overrides,
  };
}

export function createMockTurnContext(
  overrides?: Partial<TurnContext> & { readonly session?: Partial<SessionContext> },
): TurnContext {
  const session = createMockSessionContext(overrides?.session);
  return {
    session,
    turnIndex: 0,
    messages: [] as readonly InboundMessage[],
    metadata: {} as JsonObject,
    ...overrides,
    // Re-apply session after spread to ensure our merged session wins
    ...(overrides?.session ? { session } : {}),
  };
}
