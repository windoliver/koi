/**
 * Mock context factories for middleware testing.
 */

import type { JsonObject } from "@koi/core/common";
import { runId, sessionId, turnId } from "@koi/core/ecs";
import type { InboundMessage } from "@koi/core/message";
import type { SessionContext, TurnContext } from "@koi/core/middleware";

export function createMockSessionContext(overrides?: Partial<SessionContext>): SessionContext {
  const rid = overrides?.runId ?? runId("run-test-1");
  return {
    agentId: "agent-test-1",
    sessionId: sessionId("session-test-1"),
    runId: rid,
    userId: "user-test-1",
    metadata: {},
    ...overrides,
  };
}

export function createMockTurnContext(
  overrides?: Partial<TurnContext> & { readonly session?: Partial<SessionContext> },
): TurnContext {
  const session = createMockSessionContext(overrides?.session);
  const idx = overrides?.turnIndex ?? 0;
  return {
    session,
    turnIndex: idx,
    turnId: overrides?.turnId ?? turnId(session.runId, idx),
    messages: [] as readonly InboundMessage[],
    metadata: {} as JsonObject,
    ...overrides,
    // Re-apply session after spread to ensure our merged session wins
    ...(overrides?.session ? { session } : {}),
  };
}

/**
 * Creates a mock InboundMessage with sensible defaults.
 * Pass `text` for a quick single-text-block message, or override `content` for custom blocks.
 */
export function createMockInboundMessage(
  overrides?: Partial<InboundMessage> & { readonly text?: string },
): InboundMessage {
  const text = overrides?.text ?? "mock message";
  return {
    senderId: "user-test-1",
    timestamp: Date.now(),
    content: [{ kind: "text" as const, text }],
    ...overrides,
    // If text was provided but content wasn't, ensure content uses the text
    ...(overrides?.text !== undefined && overrides?.content === undefined
      ? { content: [{ kind: "text" as const, text: overrides.text }] }
      : {}),
  };
}
