import { describe, expect, test } from "bun:test";
import type { AgentMessage, InboxComponent, InboxItem, MailboxComponent } from "@koi/core";
import { agentId, messageId } from "@koi/core";
import { createInboxMiddleware } from "./inbox-middleware.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function createMessage(overrides?: Partial<AgentMessage>): AgentMessage {
  return {
    id: messageId("msg-1"),
    from: agentId("sender"),
    to: agentId("receiver"),
    kind: "event",
    createdAt: new Date().toISOString(),
    type: "test",
    payload: { text: "Hello" },
    ...overrides,
  };
}

function createFakeMailbox(messages: readonly AgentMessage[]): MailboxComponent {
  return {
    send: async () => {
      const first = messages[0];
      if (first === undefined) throw new Error("createFakeMailbox: no messages");
      return { ok: true, value: first };
    },
    onMessage: () => () => {},
    list: async () => messages,
  };
}

function createFakeInbox(): InboxComponent & { readonly items: InboxItem[] } {
  const items: InboxItem[] = [];
  return {
    items,
    drain: () => {
      const drained = [...items];
      items.length = 0;
      return drained;
    },
    peek: () => [...items],
    depth: () => items.length,
    push: (item: InboxItem) => {
      items.push(item);
      return true;
    },
  };
}

function createTurnCtx() {
  return {
    session: {
      agentId: "test-agent",
      sessionId: "test-session" as never,
      runId: "test-run" as never,
      metadata: {},
    },
    turnIndex: 0,
    turnId: "test-run:0" as never,
    messages: [],
    metadata: {},
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createInboxMiddleware", () => {
  test("has correct name and priority", () => {
    const mw = createInboxMiddleware({
      getMailbox: () => undefined,
      getInbox: () => undefined,
    });
    expect(mw.name).toBe("inbox-middleware");
    expect(mw.priority).toBe(45);
  });

  test("routes mailbox messages to inbox with default followup mode", async () => {
    const inbox = createFakeInbox();
    const msg = createMessage();

    const mw = createInboxMiddleware({
      getMailbox: () => createFakeMailbox([msg]),
      getInbox: () => inbox,
    });

    await mw.onBeforeTurn?.(createTurnCtx());

    expect(inbox.items).toHaveLength(1);
    expect(inbox.items[0]?.mode).toBe("followup");
    expect(inbox.items[0]?.content).toBe("Hello");
  });

  test("respects metadata.mode for steer", async () => {
    const inbox = createFakeInbox();
    const msg = createMessage({
      metadata: { mode: "steer" },
    });

    const mw = createInboxMiddleware({
      getMailbox: () => createFakeMailbox([msg]),
      getInbox: () => inbox,
    });

    await mw.onBeforeTurn?.(createTurnCtx());

    expect(inbox.items[0]?.mode).toBe("steer");
  });

  test("respects metadata.mode for collect", async () => {
    const inbox = createFakeInbox();
    const msg = createMessage({
      metadata: { mode: "collect" },
    });

    const mw = createInboxMiddleware({
      getMailbox: () => createFakeMailbox([msg]),
      getInbox: () => inbox,
    });

    await mw.onBeforeTurn?.(createTurnCtx());

    expect(inbox.items[0]?.mode).toBe("collect");
  });

  test("falls back to followup for invalid mode", async () => {
    const inbox = createFakeInbox();
    const msg = createMessage({
      metadata: { mode: "invalid" },
    });

    const mw = createInboxMiddleware({
      getMailbox: () => createFakeMailbox([msg]),
      getInbox: () => inbox,
    });

    await mw.onBeforeTurn?.(createTurnCtx());

    expect(inbox.items[0]?.mode).toBe("followup");
  });

  test("no-ops when mailbox is undefined", async () => {
    const inbox = createFakeInbox();

    const mw = createInboxMiddleware({
      getMailbox: () => undefined,
      getInbox: () => inbox,
    });

    await mw.onBeforeTurn?.(createTurnCtx());

    expect(inbox.items).toHaveLength(0);
  });

  test("no-ops when inbox is undefined", async () => {
    const msg = createMessage();

    const mw = createInboxMiddleware({
      getMailbox: () => createFakeMailbox([msg]),
      getInbox: () => undefined,
    });

    // Should not throw
    await mw.onBeforeTurn?.(createTurnCtx());
  });

  test("extracts text from payload", async () => {
    const inbox = createFakeInbox();
    const msg = createMessage({
      payload: { text: "Important message" },
    });

    const mw = createInboxMiddleware({
      getMailbox: () => createFakeMailbox([msg]),
      getInbox: () => inbox,
    });

    await mw.onBeforeTurn?.(createTurnCtx());

    expect(inbox.items[0]?.content).toBe("Important message");
  });

  test("JSON-serializes non-text payloads", async () => {
    const inbox = createFakeInbox();
    const msg = createMessage({
      payload: { data: 42, nested: { key: "value" } },
    });

    const mw = createInboxMiddleware({
      getMailbox: () => createFakeMailbox([msg]),
      getInbox: () => inbox,
    });

    await mw.onBeforeTurn?.(createTurnCtx());

    expect(inbox.items[0]?.content).toBe(JSON.stringify({ data: 42, nested: { key: "value" } }));
  });

  test("routes multiple messages", async () => {
    const inbox = createFakeInbox();
    const messages = [
      createMessage({ id: messageId("m1"), metadata: { mode: "collect" } }),
      createMessage({ id: messageId("m2"), metadata: { mode: "steer" } }),
      createMessage({ id: messageId("m3") }),
    ];

    const mw = createInboxMiddleware({
      getMailbox: () => createFakeMailbox(messages),
      getInbox: () => inbox,
    });

    await mw.onBeforeTurn?.(createTurnCtx());

    expect(inbox.items).toHaveLength(3);
    expect(inbox.items[0]?.mode).toBe("collect");
    expect(inbox.items[1]?.mode).toBe("steer");
    expect(inbox.items[2]?.mode).toBe("followup");
  });

  test("preserves message priority from metadata", async () => {
    const inbox = createFakeInbox();
    const msg = createMessage({
      metadata: { priority: 5 },
    });

    const mw = createInboxMiddleware({
      getMailbox: () => createFakeMailbox([msg]),
      getInbox: () => inbox,
    });

    await mw.onBeforeTurn?.(createTurnCtx());

    expect(inbox.items[0]?.priority).toBe(5);
  });

  test("does not replay already-seen messages on subsequent turns", async () => {
    const inbox = createFakeInbox();
    const msg = createMessage({ id: messageId("replay-1") });

    const mw = createInboxMiddleware({
      getMailbox: () => createFakeMailbox([msg]),
      getInbox: () => inbox,
    });

    await mw.onBeforeTurn?.(createTurnCtx());
    expect(inbox.items).toHaveLength(1);

    // Drain the inbox (simulates engine consuming items between turns)
    inbox.drain();
    expect(inbox.items).toHaveLength(0);

    // Second turn — same message returned by list() but should be skipped
    await mw.onBeforeTurn?.(createTurnCtx());
    expect(inbox.items).toHaveLength(0);
  });

  test("processes new messages while skipping already-seen ones", async () => {
    const inbox = createFakeInbox();
    const msg1 = createMessage({ id: messageId("seen-1") });
    const msg2 = createMessage({ id: messageId("new-2") });

    // Mutable backing array so we can add messages between turns
    const mailboxMessages: AgentMessage[] = [msg1];
    const mailbox: MailboxComponent = {
      send: async () => ({ ok: true, value: msg1 }),
      onMessage: () => () => {},
      list: async () => mailboxMessages,
    };

    const mw = createInboxMiddleware({
      getMailbox: () => mailbox,
      getInbox: () => inbox,
    });

    // Turn 1 — processes msg1
    await mw.onBeforeTurn?.(createTurnCtx());
    expect(inbox.items).toHaveLength(1);
    expect(inbox.items[0]?.id).toBe("seen-1");

    inbox.drain();

    // Turn 2 — msg1 still in list (non-destructive), msg2 is new
    mailboxMessages.push(msg2);
    await mw.onBeforeTurn?.(createTurnCtx());
    expect(inbox.items).toHaveLength(1);
    expect(inbox.items[0]?.id).toBe("new-2");
  });
});
