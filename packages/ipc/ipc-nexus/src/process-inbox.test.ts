import { describe, expect, mock, test } from "bun:test";
import type { AgentMessage } from "@koi/core";
import type { NexusClient, NexusMessageEnvelope } from "./nexus-client.js";
import type { MessageHandler } from "./process-inbox.js";
import { processPendingMessages } from "./process-inbox.js";

function createMockClient(messages: readonly NexusMessageEnvelope[]): NexusClient {
  return {
    sendMessage: mock(() => {
      const first = messages[0];
      if (first === undefined) throw new Error("no messages");
      return Promise.resolve({ ok: true as const, value: first });
    }),
    listInbox: mock(() => Promise.resolve({ ok: true as const, value: messages })),
    inboxCount: mock(() => Promise.resolve({ ok: true as const, value: messages.length })),
    provision: mock(() => Promise.resolve({ ok: true as const, value: undefined })),
  };
}

const ENVELOPE_A: NexusMessageEnvelope = {
  id: "msg-1",
  from: "a",
  to: "b",
  kind: "task",
  createdAt: "2026-01-01T00:00:00Z",
  type: "test",
  payload: { x: 1 },
};

const ENVELOPE_B: NexusMessageEnvelope = {
  id: "msg-2",
  from: "c",
  to: "b",
  kind: "event",
  createdAt: "2026-01-01T00:01:00Z",
  type: "deploy",
  payload: { v: 2 },
};

describe("processPendingMessages", () => {
  test("returns 0 for empty inbox", async () => {
    const client = createMockClient([]);
    const handlers = new Set<MessageHandler>();
    const seen = new Set<string>();

    const count = await processPendingMessages(client, "b", handlers, seen, 50);
    expect(count).toBe(0);
  });

  test("dispatches new messages to all handlers", async () => {
    const client = createMockClient([ENVELOPE_A, ENVELOPE_B]);
    const received: AgentMessage[] = [];
    const handler1 = mock((msg: AgentMessage) => {
      received.push(msg);
    });
    const handler2 = mock((msg: AgentMessage) => {
      received.push(msg);
    });
    const handlers = new Set<MessageHandler>([handler1, handler2]);
    const seen = new Set<string>();

    const count = await processPendingMessages(client, "b", handlers, seen, 50);

    expect(count).toBe(2);
    expect(handler1).toHaveBeenCalledTimes(2);
    expect(handler2).toHaveBeenCalledTimes(2);
    expect(received).toHaveLength(4); // 2 messages x 2 handlers
  });

  test("deduplicates via seen set", async () => {
    const client = createMockClient([ENVELOPE_A]);
    const handler = mock(() => {});
    const handlers = new Set<MessageHandler>([handler]);
    const seen = new Set<string>(["msg-1"]); // Already seen

    const count = await processPendingMessages(client, "b", handlers, seen, 50);

    expect(count).toBe(0);
    expect(handler).not.toHaveBeenCalled();
  });

  test("adds processed message IDs to seen set", async () => {
    const client = createMockClient([ENVELOPE_A]);
    const handlers = new Set<MessageHandler>([mock(() => {})]);
    const seen = new Set<string>();

    await processPendingMessages(client, "b", handlers, seen, 50);

    expect(seen.has("msg-1")).toBe(true);
  });

  test("handler errors do not crash the loop but skip failed messages", async () => {
    const client = createMockClient([ENVELOPE_A, ENVELOPE_B]);
    const throwingHandler = mock(() => {
      throw new Error("handler boom");
    });
    const handlers = new Set<MessageHandler>([throwingHandler]);
    const seen = new Set<string>();

    const count = await processPendingMessages(client, "b", handlers, seen, 50);

    // Failed messages are not marked seen — will be retried on next poll
    expect(count).toBe(0);
    expect(seen.has("msg-1")).toBe(false);
    expect(seen.has("msg-2")).toBe(false);
  });

  test("returns 0 when listInbox fails", async () => {
    const client: NexusClient = {
      sendMessage: mock(() => Promise.resolve({ ok: true as const, value: ENVELOPE_A })),
      listInbox: mock(() =>
        Promise.resolve({
          ok: false as const,
          error: { code: "EXTERNAL" as const, message: "down", retryable: false },
        }),
      ),
      inboxCount: mock(() => Promise.resolve({ ok: true as const, value: 0 })),
      provision: mock(() => Promise.resolve({ ok: true as const, value: undefined })),
    };
    const handlers = new Set<MessageHandler>([mock(() => {})]);
    const seen = new Set<string>();

    const count = await processPendingMessages(client, "b", handlers, seen, 50);
    expect(count).toBe(0);
  });

  test("skips messages with unknown Nexus kind", async () => {
    const unknownKind: NexusMessageEnvelope = {
      ...ENVELOPE_A,
      id: "msg-unknown",
      kind: "banana",
    };
    const client = createMockClient([unknownKind, ENVELOPE_B]);
    const handler = mock(() => {});
    const handlers = new Set<MessageHandler>([handler]);
    const seen = new Set<string>();

    const count = await processPendingMessages(client, "b", handlers, seen, 50);

    // Only ENVELOPE_B should be processed (unknown kind skipped)
    expect(count).toBe(1);
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
