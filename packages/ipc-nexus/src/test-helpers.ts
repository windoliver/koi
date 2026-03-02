/**
 * Test helpers for @koi/ipc-nexus — mock MailboxComponent and AgentRegistry
 * for downstream consumers.
 */

import type {
  AgentMessage,
  AgentMessageInput,
  AgentRegistry,
  KoiError,
  MailboxComponent,
  MessageFilter,
  RegistryEntry,
  Result,
} from "@koi/core";
import { agentId, matchesFilter, messageId } from "@koi/core";

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

// ---------------------------------------------------------------------------
// Mock AgentRegistry
// ---------------------------------------------------------------------------

const DEFAULT_REGISTRY_ENTRIES: readonly RegistryEntry[] = [
  {
    agentId: agentId("copilot-1"),
    status: {
      phase: "running",
      generation: 1,
      conditions: [],
      lastTransitionAt: 1_700_000_000_000,
    },
    agentType: "copilot",
    metadata: {},
    registeredAt: 1_700_000_000_000,
    priority: 10,
  },
  {
    agentId: agentId("worker-1"),
    status: {
      phase: "running",
      generation: 1,
      conditions: [],
      lastTransitionAt: 1_700_000_001_000,
    },
    agentType: "worker",
    metadata: {},
    registeredAt: 1_700_000_001_000,
    priority: 10,
  },
  {
    agentId: agentId("worker-2"),
    status: {
      phase: "suspended",
      generation: 2,
      conditions: [],
      lastTransitionAt: 1_700_000_002_000,
    },
    agentType: "worker",
    metadata: {},
    registeredAt: 1_700_000_002_000,
    priority: 10,
  },
];

/** Create a mock AgentRegistry backed by an in-memory array. */
export function createMockRegistry(options?: {
  readonly entries?: readonly RegistryEntry[];
}): AgentRegistry {
  const entries = options?.entries ?? DEFAULT_REGISTRY_ENTRIES;

  return {
    register: async (entry) => entry,
    deregister: async () => true,
    lookup: async (id) => entries.find((e) => e.agentId === id),
    list: async (filter, _visibility?) => {
      if (filter === undefined) return entries;
      return entries.filter((e) => matchesFilter(e, filter));
    },
    transition: async (_id, _target, _gen, _reason) => ({
      ok: false,
      error: {
        code: "NOT_FOUND",
        message: "mock: transition not implemented",
        retryable: false,
        context: {},
      },
    }),
    patch: async () => ({
      ok: false,
      error: {
        code: "NOT_FOUND",
        message: "mock: patch not implemented",
        retryable: false,
        context: {},
      },
    }),
    watch: () => () => {},
    [Symbol.asyncDispose]: async () => {},
  };
}
