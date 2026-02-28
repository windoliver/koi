/**
 * Test helpers for @koi/ipc-nexus — mock MailboxComponent for downstream consumers.
 */

import type {
  AgentMessage,
  AgentMessageInput,
  KoiError,
  MailboxComponent,
  MessageFilter,
  Result,
} from "@koi/core";
import { agentId, messageId } from "@koi/core";

export { createMockAgent } from "@koi/test-utils";

/** Create a mock MailboxComponent with canned responses. */
export function createMockMailboxComponent(options?: {
  readonly messages?: readonly AgentMessage[];
}): MailboxComponent {
  const messages: readonly AgentMessage[] = options?.messages ?? [
    {
      id: messageId("msg-001"),
      from: agentId("agent-a"),
      to: agentId("agent-b"),
      kind: "request",
      createdAt: "2026-01-01T00:00:00Z",
      type: "code-review",
      payload: { file: "src/main.ts" },
    },
    {
      id: messageId("msg-002"),
      from: agentId("agent-c"),
      to: agentId("agent-b"),
      kind: "event",
      createdAt: "2026-01-01T00:01:00Z",
      type: "deploy",
      payload: { version: "1.0.0" },
    },
  ];

  const handlers = new Set<(message: AgentMessage) => void | Promise<void>>();

  return {
    send: async (input: AgentMessageInput): Promise<Result<AgentMessage, KoiError>> => {
      const sent: AgentMessage = {
        id: messageId(`msg-${Date.now()}`),
        from: input.from,
        to: input.to,
        kind: input.kind,
        createdAt: new Date().toISOString(),
        type: input.type,
        payload: input.payload,
        ...(input.correlationId !== undefined ? { correlationId: input.correlationId } : {}),
        ...(input.ttlSeconds !== undefined ? { ttlSeconds: input.ttlSeconds } : {}),
        ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
      };
      return { ok: true, value: sent };
    },

    onMessage: (handler) => {
      handlers.add(handler);
      return () => {
        handlers.delete(handler);
      };
    },

    list: (filter?: MessageFilter) => {
      if (filter === undefined) return messages;
      return messages
        .filter((m) => {
          if (filter.kind !== undefined && m.kind !== filter.kind) return false;
          if (filter.type !== undefined && m.type !== filter.type) return false;
          if (filter.from !== undefined && m.from !== filter.from) return false;
          return true;
        })
        .slice(0, filter.limit ?? messages.length);
    },
  };
}
