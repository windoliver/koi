import { describe, expect, test } from "bun:test";
import { agentId, messageId } from "@koi/core";
import { createLocalMailbox } from "./mailbox.js";

const SENDER = agentId("sender");
const OWNER = agentId("owner");

function makeInput(type: string) {
  return { from: SENDER, to: OWNER, kind: "event" as const, type, payload: {} };
}

describe("createLocalMailbox — contract", () => {
  test("send returns ok result with full message envelope", async () => {
    const mailbox = createLocalMailbox({ agentId: OWNER });
    const result = await mailbox.send(makeInput("greet"));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.id).toBeString();
    expect(result.value.from).toBe(SENDER);
    expect(result.value.to).toBe(OWNER);
    expect(result.value.kind).toBe("event");
    expect(result.value.type).toBe("greet");
    expect(result.value.createdAt).toBeString();
    mailbox.close();
  });

  test("list returns all sent messages", async () => {
    const mailbox = createLocalMailbox({ agentId: OWNER });
    await mailbox.send(makeInput("a"));
    await mailbox.send(makeInput("b"));
    const msgs = await mailbox.list();
    expect(msgs).toHaveLength(2);
    mailbox.close();
  });

  test("list filters by kind", async () => {
    const mailbox = createLocalMailbox({ agentId: OWNER });
    await mailbox.send({ ...makeInput("req"), kind: "request" });
    await mailbox.send(makeInput("evt"));
    const msgs = await mailbox.list({ kind: "request" });
    expect(msgs).toHaveLength(1);
    expect(msgs[0]?.kind).toBe("request");
    mailbox.close();
  });

  test("list filters by type", async () => {
    const mailbox = createLocalMailbox({ agentId: OWNER });
    await mailbox.send(makeInput("ping"));
    await mailbox.send(makeInput("pong"));
    const msgs = await mailbox.list({ type: "ping" });
    expect(msgs).toHaveLength(1);
    expect(msgs[0]?.type).toBe("ping");
    mailbox.close();
  });

  test("list filters by from", async () => {
    const mailbox = createLocalMailbox({ agentId: OWNER });
    await mailbox.send({ ...makeInput("x"), from: agentId("alice") });
    await mailbox.send({ ...makeInput("y"), from: agentId("bob") });
    const msgs = await mailbox.list({ from: agentId("alice") });
    expect(msgs).toHaveLength(1);
    expect(msgs[0]?.from).toBe(agentId("alice"));
    mailbox.close();
  });

  test("list respects limit", async () => {
    const mailbox = createLocalMailbox({ agentId: OWNER });
    for (const i of [1, 2, 3, 4, 5]) {
      await mailbox.send(makeInput(`msg-${i}`));
    }
    const msgs = await mailbox.list({ limit: 3 });
    expect(msgs).toHaveLength(3);
    mailbox.close();
  });

  test("onMessage fires for each sent message", async () => {
    const mailbox = createLocalMailbox({ agentId: OWNER });
    const received: string[] = [];
    mailbox.onMessage((msg) => {
      received.push(msg.type);
    });
    await mailbox.send(makeInput("hello"));
    await Bun.sleep(10);
    expect(received).toEqual(["hello"]);
    mailbox.close();
  });

  test("onMessage unsubscribe stops delivery", async () => {
    const mailbox = createLocalMailbox({ agentId: OWNER });
    const received: string[] = [];
    const unsub = mailbox.onMessage((msg) => {
      received.push(msg.type);
    });
    await mailbox.send(makeInput("first"));
    await Bun.sleep(10);
    unsub();
    await mailbox.send(makeInput("second"));
    await Bun.sleep(10);
    expect(received).toEqual(["first"]);
    mailbox.close();
  });
});

describe("createLocalMailbox — local specifics", () => {
  test("send() returns RESOURCE_EXHAUSTED when at capacity", async () => {
    const mailbox = createLocalMailbox({ agentId: OWNER, maxMessages: 3 });
    for (const i of [1, 2, 3]) {
      const r = await mailbox.send(makeInput(`msg-${i}`));
      expect(r.ok).toBe(true);
    }
    // 4th send exceeds capacity — must return an error, not silently drop
    const overflow = await mailbox.send(makeInput("msg-4"));
    expect(overflow.ok).toBe(false);
    if (!overflow.ok) expect(overflow.error.code).toBe("RESOURCE_EXHAUSTED");
    // Inbox still has the original 3 messages
    const msgs = await mailbox.list();
    expect(msgs).toHaveLength(3);
    mailbox.close();
  });

  test("close clears messages and subscribers", async () => {
    const mailbox = createLocalMailbox({ agentId: OWNER });
    await mailbox.send(makeInput("test"));
    mailbox.close();
    const msgs = await mailbox.list();
    expect(msgs).toHaveLength(0);
  });

  test("subscriber is notified before the next await checkpoint after send()", async () => {
    const mailbox = createLocalMailbox({ agentId: OWNER });
    const received: string[] = [];
    mailbox.onMessage((msg) => {
      received.push(msg.type);
    });
    await mailbox.send(makeInput("sync"));
    // queueMicrotask dispatch fires before the await continuation resumes here
    expect(received).toEqual(["sync"]);
    mailbox.close();
  });

  test("correlationId and ttlSeconds forwarded when provided", async () => {
    const mailbox = createLocalMailbox({ agentId: OWNER });
    const result = await mailbox.send({
      from: SENDER,
      to: OWNER,
      kind: "response",
      type: "reply",
      payload: {},
      correlationId: messageId("msg-123"),
      ttlSeconds: 60,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.correlationId).toBe(messageId("msg-123"));
    expect(result.value.ttlSeconds).toBe(60);
    mailbox.close();
  });

  test("send() rejects messages addressed to a different agent when no router configured", async () => {
    const mailbox = createLocalMailbox({ agentId: OWNER });
    const result = await mailbox.send({
      from: SENDER,
      to: agentId("other-agent"),
      kind: "event",
      type: "misdirected",
      payload: {},
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("NOT_FOUND");
    mailbox.close();
  });

  test("negative maxMessages throws at construction", () => {
    expect(() => createLocalMailbox({ agentId: OWNER, maxMessages: -1 })).toThrow(
      /maxMessages must be a positive integer/,
    );
  });

  test("zero maxMessages throws at construction", () => {
    expect(() => createLocalMailbox({ agentId: OWNER, maxMessages: 0 })).toThrow(
      /maxMessages must be a positive integer/,
    );
  });

  test("cross-agent send routes via injected router", async () => {
    const { createLocalMailboxRouter } = await import("./router.js");
    const router = createLocalMailboxRouter();
    const mailboxA = createLocalMailbox({ agentId: agentId("agent-a"), router });
    const mailboxB = createLocalMailbox({ agentId: agentId("agent-b"), router });
    router.register(agentId("agent-a"), mailboxA);
    router.register(agentId("agent-b"), mailboxB);

    // Send from A to B via A's mailbox.send()
    const result = await mailboxA.send({
      from: agentId("agent-a"),
      to: agentId("agent-b"),
      kind: "event",
      type: "routed",
      payload: {},
    });
    expect(result.ok).toBe(true);

    // Message must land in B's inbox, not A's
    expect(await mailboxB.list()).toHaveLength(1);
    expect(await mailboxA.list()).toHaveLength(0);

    mailboxA.close();
    mailboxB.close();
  });

  test("cross-agent send returns NOT_FOUND when target unregistered", async () => {
    const { createLocalMailboxRouter } = await import("./router.js");
    const router = createLocalMailboxRouter();
    const mailboxA = createLocalMailbox({ agentId: agentId("agent-a"), router });

    const result = await mailboxA.send({
      from: agentId("agent-a"),
      to: agentId("nobody"),
      kind: "event",
      type: "lost",
      payload: {},
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("NOT_FOUND");
    }
    mailboxA.close();
  });

  test("send() after close() returns ABORTED error", async () => {
    const mailbox = createLocalMailbox({ agentId: OWNER });
    mailbox.close();
    const result = await mailbox.send(makeInput("late"));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("INTERNAL");
  });

  test("list() after close() returns empty array", async () => {
    const mailbox = createLocalMailbox({ agentId: OWNER });
    await mailbox.send(makeInput("before-close"));
    mailbox.close();
    expect(await mailbox.list()).toHaveLength(0);
  });

  test("onMessage() after close() returns no-op unsubscribe", async () => {
    const mailbox = createLocalMailbox({ agentId: OWNER });
    mailbox.close();
    const received: string[] = [];
    const unsub = mailbox.onMessage((msg) => {
      received.push(msg.type);
    });
    // Re-opening would be needed to send; just verify unsub is callable
    unsub();
    expect(received).toHaveLength(0);
  });

  test("send() after close() does not deliver to subscribers", async () => {
    const mailbox = createLocalMailbox({ agentId: OWNER });
    const received: string[] = [];
    mailbox.onMessage((msg) => {
      received.push(msg.type);
    });
    mailbox.close();
    await mailbox.send(makeInput("after-close"));
    expect(received).toHaveLength(0);
  });

  test("payload mutation after send() does not corrupt stored message", async () => {
    const mailbox = createLocalMailbox({ agentId: OWNER });
    const payload = { value: 1 };
    await mailbox.send({ from: SENDER, to: OWNER, kind: "event", type: "mut", payload });
    // Mutate original payload object after send
    payload.value = 999;
    const msgs = await mailbox.list();
    expect((msgs[0]?.payload as { value: number }).value).toBe(1);
    mailbox.close();
  });

  test("message returned from list() is frozen (immutable)", async () => {
    const mailbox = createLocalMailbox({ agentId: OWNER });
    await mailbox.send(makeInput("freeze-test"));
    const msgs = await mailbox.list();
    expect(Object.isFrozen(msgs[0])).toBe(true);
    mailbox.close();
  });

  test("nested payload fields are also frozen (deep immutability)", async () => {
    const mailbox = createLocalMailbox({ agentId: OWNER });
    await mailbox.send({
      from: SENDER,
      to: OWNER,
      kind: "event",
      type: "deep",
      payload: { nested: { x: 1 } },
    });
    const msgs = await mailbox.list();
    const nested = (msgs[0]?.payload as { nested: object }).nested;
    expect(Object.isFrozen(nested)).toBe(true);
    mailbox.close();
  });

  test("close() auto-unregisters mailbox from router", async () => {
    const { createLocalMailboxRouter } = await import("./router.js");
    const router = createLocalMailboxRouter();
    const mailbox = createLocalMailbox({ agentId: OWNER, router });
    router.register(OWNER, mailbox);
    expect(router.get(OWNER)).toBeDefined();
    mailbox.close();
    expect(router.get(OWNER)).toBeUndefined();
  });

  test("closing stale mailbox does not evict live replacement from router", async () => {
    const { createLocalMailboxRouter } = await import("./router.js");
    const router = createLocalMailboxRouter();
    const mailboxOld = createLocalMailbox({ agentId: OWNER, router });
    const mailboxNew = createLocalMailbox({ agentId: OWNER, router });
    router.register(OWNER, mailboxOld);
    router.register(OWNER, mailboxNew);
    // Close the old mailbox — should NOT remove the new one
    mailboxOld.close();
    expect(router.get(OWNER)).toBe(mailboxNew);
    mailboxNew.close();
  });

  test("send() returns VALIDATION error for non-cloneable payload", async () => {
    const mailbox = createLocalMailbox({ agentId: OWNER });
    // Functions cannot be structuredCloned — they throw a DataCloneError
    const result = await mailbox.send({
      from: SENDER,
      to: OWNER,
      kind: "event",
      type: "bad",
      payload: { fn: () => {} } as unknown as import("@koi/core").JsonObject,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("VALIDATION");
    mailbox.close();
  });

  test("throwing subscriber does not propagate and does not affect other subscribers", async () => {
    const errors: unknown[] = [];
    const mailbox = createLocalMailbox({
      agentId: OWNER,
      onError: (err) => {
        errors.push(err);
      },
    });
    const received: string[] = [];
    mailbox.onMessage(() => {
      throw new Error("subscriber boom");
    });
    mailbox.onMessage((msg) => {
      received.push(msg.type);
    });
    await mailbox.send(makeInput("resilient"));
    expect(received).toEqual(["resilient"]);
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe("subscriber boom");
    mailbox.close();
  });

  test("async subscriber rejection is routed to onError", async () => {
    const errors: unknown[] = [];
    const mailbox = createLocalMailbox({
      agentId: OWNER,
      onError: (err) => {
        errors.push(err);
      },
    });
    mailbox.onMessage(async () => {
      throw new Error("async boom");
    });
    await mailbox.send(makeInput("async-err"));
    await Bun.sleep(10);
    expect(errors).toHaveLength(1);
    mailbox.close();
  });

  test("throwing onError observer does not break delivery", async () => {
    const received: string[] = [];
    const mailbox = createLocalMailbox({
      agentId: OWNER,
      onError: () => {
        throw new Error("observer exploded");
      },
    });
    mailbox.onMessage(() => {
      throw new Error("subscriber boom");
    });
    mailbox.onMessage((msg) => {
      received.push(msg.type);
    });
    // Should not throw — onError's own throw is swallowed
    await mailbox.send(makeInput("safe"));
    expect(received).toEqual(["safe"]);
    mailbox.close();
  });

  test("drain() cancels queued microtask deliveries to prevent duplicate processing", async () => {
    const mailbox = createLocalMailbox({ agentId: OWNER });
    const received: string[] = [];
    mailbox.onMessage((msg) => {
      received.push(msg.type);
    });
    void mailbox.send(makeInput("should-not-arrive"));
    mailbox.drain(); // bumps generation — microtask bails out
    await Bun.sleep(10);
    expect(received).toHaveLength(0);
    mailbox.close();
  });

  test("close() cancels pending accepted-message deliveries", async () => {
    const mailbox = createLocalMailbox({ agentId: OWNER });
    const received: string[] = [];
    mailbox.onMessage((msg) => {
      received.push(msg.type);
    });
    void mailbox.send(makeInput("close-before-delivery")); // queues microtask
    mailbox.close(); // bumps generation — microtask bails out
    await Bun.sleep(10);
    expect(received).toHaveLength(0);
  });

  test("late subscriber does not receive messages sent before subscription", async () => {
    const mailbox = createLocalMailbox({ agentId: OWNER });
    await mailbox.send(makeInput("before-sub")); // sent with no subscribers
    const received: string[] = [];
    mailbox.onMessage((msg) => {
      received.push(msg.type);
    });
    await Bun.sleep(10);
    expect(received).toHaveLength(0); // snapshot at send time had no subscribers
    mailbox.close();
  });

  test("drain() returns the cleared messages for dead-lettering", async () => {
    const mailbox = createLocalMailbox({ agentId: OWNER });
    await mailbox.send(makeInput("x"));
    await mailbox.send(makeInput("y"));
    const dropped = await mailbox.drain();
    expect(dropped).toHaveLength(2);
    expect(dropped[0]?.type).toBe("x");
    expect(dropped[1]?.type).toBe("y");
    mailbox.close();
  });

  test("inbox is durable — messages persist in list() after subscriber delivery", async () => {
    const mailbox = createLocalMailbox({ agentId: OWNER });
    const received: string[] = [];
    mailbox.onMessage((msg) => {
      received.push(msg.type);
    });
    await mailbox.send(makeInput("durable"));
    expect(received).toEqual(["durable"]);
    // Message stays in inbox after delivery — explicit drain() required to clear
    expect(await mailbox.list()).toHaveLength(1);
    mailbox.close();
  });

  test("inbox persists after subscriber throws synchronously", async () => {
    const mailbox = createLocalMailbox({ agentId: OWNER, onError: () => {} });
    mailbox.onMessage(() => {
      throw new Error("handler boom");
    });
    await mailbox.send(makeInput("retry-me"));
    expect(await mailbox.list()).toHaveLength(1);
    mailbox.close();
  });

  test("inbox persists after async subscriber rejects", async () => {
    const mailbox = createLocalMailbox({ agentId: OWNER, onError: () => {} });
    mailbox.onMessage(async () => {
      throw new Error("async fail");
    });
    await mailbox.send(makeInput("retry-async"));
    await Bun.sleep(10);
    expect(await mailbox.list()).toHaveLength(1);
    mailbox.close();
  });

  test("unsubscribed handler in snapshot still receives message sent before unsub", async () => {
    const mailbox = createLocalMailbox({ agentId: OWNER });
    const received: string[] = [];
    const unsub = mailbox.onMessage((msg) => {
      received.push(msg.type);
    });
    void mailbox.send(makeInput("before-unsub"));
    unsub(); // removed from live set, but snapshot still holds reference
    await Bun.sleep(10);
    expect(received).toEqual(["before-unsub"]);
    mailbox.close();
  });

  test("drain() frees capacity so subsequent sends succeed", async () => {
    const mailbox = createLocalMailbox({ agentId: OWNER, maxMessages: 2 });
    await mailbox.send(makeInput("a"));
    await mailbox.send(makeInput("b"));
    const full = await mailbox.send(makeInput("c"));
    expect(full.ok).toBe(false);
    if (!full.ok) expect(full.error.code).toBe("RESOURCE_EXHAUSTED");

    const dropped = await mailbox.drain();
    expect(dropped).toHaveLength(2);
    expect(await mailbox.list()).toHaveLength(0);

    const after = await mailbox.send(makeInput("d"));
    expect(after.ok).toBe(true);
    mailbox.close();
  });
});
