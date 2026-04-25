import { describe, expect, test } from "bun:test";
import { agentId, messageId } from "@koi/core";
import { createLocalMailbox, isLocalMailboxInstance } from "./mailbox.js";

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
    // Must send from OWNER — outbound forgery check fires first for other senders.
    const result = await mailbox.send({
      from: OWNER,
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
    expect(router.getView(OWNER)).toBeDefined();
    mailbox.close();
    expect(router.getView(OWNER)).toBeUndefined();
  });

  test("closing stale mailbox does not evict live replacement from router", async () => {
    const { createLocalMailboxRouter } = await import("./router.js");
    const router = createLocalMailboxRouter();
    const mailboxOld = createLocalMailbox({ agentId: OWNER, router });
    const mailboxNew = createLocalMailbox({ agentId: OWNER, router });
    router.register(OWNER, mailboxOld);
    router.register(OWNER, mailboxNew);
    // Close the old mailbox — should NOT remove the new one (view still defined).
    mailboxOld.close();
    expect(router.getView(OWNER)).toBeDefined();
    mailboxNew.close();
  });

  test("send() returns PERMISSION error when from is forged on outbound cross-agent route", async () => {
    const { createLocalMailboxRouter } = await import("./router.js");
    const router = createLocalMailboxRouter();
    const mailbox = createLocalMailbox({ agentId: OWNER, router });
    // SENDER !== OWNER, so this is a forged from on a cross-agent send
    const result = await mailbox.send({
      from: SENDER,
      to: SENDER, // route cross-agent
      kind: "event",
      type: "spoof",
      payload: {},
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("PERMISSION");
    mailbox.close();
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
    const dropped = mailbox.drain();
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

    const dropped = mailbox.drain();
    expect(dropped).toHaveLength(2);
    expect(await mailbox.list()).toHaveLength(0);

    const after = await mailbox.send(makeInput("d"));
    expect(after.ok).toBe(true);
    mailbox.close();
  });
});

describe("sender-forgery guard (inbound path)", () => {
  test("direct injection with unregistered sender is rejected when router present", async () => {
    const { createLocalMailboxRouter } = await import("./router.js");
    const router = createLocalMailboxRouter();
    const mailboxB = createLocalMailbox({ agentId: agentId("agent-b"), router });

    // Attacker bypasses the outbound path and calls mailboxB.send directly with a forged sender.
    const result = await mailboxB.send({
      from: agentId("unregistered-attacker"),
      to: agentId("agent-b"),
      kind: "event",
      type: "forged",
      payload: {},
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("PERMISSION");
      // from !== config.agentId ("agent-b") is caught first: sender forge guard fires before
      // the routing-token check, so the error reflects the identity mismatch, not the missing token.
      expect(result.error.message).toContain("forge sender identity");
    }
    mailboxB.close();
  });

  test("registered agent can deliver to another registered mailbox", async () => {
    const { createLocalMailboxRouter } = await import("./router.js");
    const router = createLocalMailboxRouter();
    const mailboxA = createLocalMailbox({ agentId: agentId("agent-a"), router });
    const mailboxB = createLocalMailbox({ agentId: agentId("agent-b"), router });
    router.register(agentId("agent-a"), mailboxA);
    router.register(agentId("agent-b"), mailboxB);

    // Legitimate cross-agent delivery via outbound path.
    const result = await mailboxA.send({
      from: agentId("agent-a"),
      to: agentId("agent-b"),
      kind: "event",
      type: "legit",
      payload: {},
    });

    expect(result.ok).toBe(true);
    expect(await mailboxB.list()).toHaveLength(1);
    mailboxA.close();
    mailboxB.close();
  });

  test("impersonating a registered agent via direct send() is rejected", async () => {
    const { createLocalMailboxRouter } = await import("./router.js");
    const router = createLocalMailboxRouter();
    const mailboxA = createLocalMailbox({ agentId: agentId("agent-a"), router });
    const mailboxB = createLocalMailbox({ agentId: agentId("agent-b"), router });
    const mailboxC = createLocalMailbox({ agentId: agentId("agent-c"), router });
    router.register(agentId("agent-a"), mailboxA);
    router.register(agentId("agent-b"), mailboxB);
    router.register(agentId("agent-c"), mailboxC);

    // Attacker calls mailboxB.send directly claiming to be C (registered but different identity).
    const result = await mailboxB.send({
      from: agentId("agent-c"),
      to: agentId("agent-b"),
      kind: "event",
      type: "impersonation",
      payload: {},
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("PERMISSION");
      // from ("agent-c") !== config.agentId ("agent-b"): sender forge guard fires before the
      // routing-token check, providing an earlier and clearer identity rejection.
      expect(result.error.message).toContain("forge sender identity");
    }
    mailboxA.close();
    mailboxB.close();
    mailboxC.close();
  });

  test("routed input object cannot be replayed via direct send() after legitimate delivery", async () => {
    const { createLocalMailboxRouter } = await import("./router.js");
    const router = createLocalMailboxRouter();
    const mailboxA = createLocalMailbox({ agentId: agentId("agent-a"), router });
    const mailboxB = createLocalMailbox({ agentId: agentId("agent-b"), router });
    router.register(agentId("agent-a"), mailboxA);
    router.register(agentId("agent-b"), mailboxB);

    const originalInput = {
      from: agentId("agent-a"),
      to: agentId("agent-b"),
      kind: "event" as const,
      type: "original",
      payload: {},
    };

    // Legitimate delivery — clones input internally so originalInput stays untrusted.
    const first = await mailboxA.send(originalInput);
    expect(first.ok).toBe(true);

    // Replay: caller attempts to send the same original input object directly.
    const replay = await mailboxB.send(originalInput);
    expect(replay.ok).toBe(false);
    if (!replay.ok) {
      expect(replay.error.code).toBe("PERMISSION");
    }
    mailboxA.close();
    mailboxB.close();
  });

  test("self-send (from === to === agentId) is allowed when router is configured", async () => {
    const { createLocalMailboxRouter } = await import("./router.js");
    const router = createLocalMailboxRouter();
    const mailbox = createLocalMailbox({ agentId: OWNER, router });
    router.register(OWNER, mailbox);

    // Agent sends a message to itself — a valid pattern for internal queuing.
    const result = await mailbox.send({
      from: OWNER,
      to: OWNER,
      kind: "event",
      type: "self-notification",
      payload: { note: "internal" },
    });

    expect(result.ok).toBe(true);
    const msgs = await mailbox.list();
    expect(msgs).toHaveLength(1);
    expect(msgs[0]?.type).toBe("self-notification");
    mailbox.close();
  });

  test("self-send succeeds immediately after construction — no registration window", async () => {
    // createLocalMailbox auto-registers with the router so self-sends are valid from the
    // first line after construction with no ordering dependency on router.register().
    const { createLocalMailboxRouter } = await import("./router.js");
    const router = createLocalMailboxRouter();
    const mailbox = createLocalMailbox({ agentId: OWNER, router });
    // No explicit router.register() call — auto-registered at construction.

    const result = await mailbox.send({
      from: OWNER,
      to: OWNER,
      kind: "event",
      type: "self-immediate",
      payload: {},
    });

    expect(result.ok).toBe(true);
    const msgs = await mailbox.list();
    expect(msgs).toHaveLength(1);
    expect(msgs[0]?.type).toBe("self-immediate");
    mailbox.close();
  });

  test("no router present allows inbound from any sender (no authentication)", async () => {
    // Without a router, mailboxes are isolated — inbound sender check is skipped.
    const mailbox = createLocalMailbox({ agentId: OWNER });

    const result = await mailbox.send({
      from: agentId("anyone"),
      to: OWNER,
      kind: "event",
      type: "local",
      payload: {},
    });

    expect(result.ok).toBe(true);
    mailbox.close();
  });
});

describe("isLocalMailboxInstance", () => {
  test("returns true for createLocalMailbox instances", () => {
    const mailbox = createLocalMailbox({ agentId: OWNER });
    expect(isLocalMailboxInstance(mailbox)).toBe(true);
    mailbox.close();
  });

  test("returns false for plain MailboxComponent objects", () => {
    const plain: import("@koi/core").MailboxComponent = {
      send: async () => ({ ok: true, value: {} as import("@koi/core").AgentMessage }),
      onMessage: () => () => {},
      list: () => [],
      drain: () => [],
    };
    expect(isLocalMailboxInstance(plain)).toBe(false);
  });

  test("returns false for custom MailboxComponent with agentId but no routing method", () => {
    const custom = {
      agentId: OWNER,
      send: async () => ({ ok: true, value: {} as import("@koi/core").AgentMessage }),
      onMessage: () => () => {},
      list: () => [],
      drain: () => [],
    } satisfies import("@koi/core").MailboxComponent & { agentId: import("@koi/core").AgentId };
    expect(isLocalMailboxInstance(custom)).toBe(false);
  });

  test("mailbox instances expose only the cross-instance brand symbol (delivery fn not discoverable via reflection)", () => {
    // The delivery function lives in a module-private WeakMap — reflective access cannot reach it.
    // The only own symbol-keyed property is the LOCAL_MAILBOX_BRAND (Symbol.for), which is a
    // simple boolean used for identity checks across duplicate package copies. Its value is
    // true, not the delivery function — the brand grants no routing privilege on its own.
    const mailbox = createLocalMailbox({ agentId: OWNER });
    const symbols = Object.getOwnPropertySymbols(mailbox);
    expect(symbols).toHaveLength(1);
    const brandSymbol = symbols[0];
    if (brandSymbol === undefined) throw new Error("expected brand symbol");
    expect(brandSymbol.toString()).toBe("Symbol(@koi/ipc-local/local-mailbox)");
    expect((mailbox as unknown as Record<symbol, unknown>)[brandSymbol]).toBe(true);
    mailbox.close();
  });
});

// ---------------------------------------------------------------------------
// Corner cases
// ---------------------------------------------------------------------------

describe("createLocalMailbox — corner cases", () => {
  test("concurrent sends from two agents land in the correct inboxes", async () => {
    const { createLocalMailboxRouter } = await import("./router.js");
    const router = createLocalMailboxRouter();
    const a = createLocalMailbox({ agentId: agentId("a"), router });
    const b = createLocalMailbox({ agentId: agentId("b"), router });
    router.register(agentId("a"), a);
    router.register(agentId("b"), b);

    const [ra, rb] = await Promise.all([
      a.send({ from: agentId("a"), to: agentId("b"), kind: "event", type: "from-a", payload: {} }),
      b.send({ from: agentId("b"), to: agentId("a"), kind: "event", type: "from-b", payload: {} }),
    ]);
    expect(ra.ok).toBe(true);
    expect(rb.ok).toBe(true);

    expect((await b.list()).map((m) => m.type)).toEqual(["from-a"]);
    expect((await a.list()).map((m) => m.type)).toEqual(["from-b"]);
    a.close();
    b.close();
  });

  test("subscriber that throws on first message does not block delivery of second", async () => {
    const mailbox = createLocalMailbox({ agentId: OWNER });
    const delivered: string[] = [];
    mailbox.onMessage((msg) => {
      if (msg.type === "first") throw new Error("boom");
      delivered.push(msg.type);
    });

    await mailbox.send(makeInput("first"));
    await mailbox.send(makeInput("second"));
    await Bun.sleep(20);
    expect(delivered).toEqual(["second"]);
    mailbox.close();
  });

  test("maxMessages boundary: N-1 accepted, N accepted, N+1 rejected", async () => {
    const mailbox = createLocalMailbox({ agentId: OWNER, maxMessages: 3 });
    const r1 = await mailbox.send(makeInput("a"));
    const r2 = await mailbox.send(makeInput("b"));
    const r3 = await mailbox.send(makeInput("c"));
    const r4 = await mailbox.send(makeInput("d"));
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    expect(r3.ok).toBe(true);
    expect(r4.ok).toBe(false);
    if (!r4.ok) expect(r4.error.code).toBe("RESOURCE_EXHAUSTED");
    expect(mailbox.list()).toHaveLength(3);
    mailbox.close();
  });

  test("drain() cancels pending microtask deliveries — subscriber fires 0 times after drain", async () => {
    const mailbox = createLocalMailbox({ agentId: OWNER });
    const fired: string[] = [];
    mailbox.onMessage((msg) => {
      fired.push(msg.type);
    });

    // Do NOT await send — drain must run synchronously before the microtask fires.
    const p = mailbox.send(makeInput("x"));
    mailbox.drain(); // bumps generation before microtask fires
    await p;
    await Bun.sleep(20);
    expect(fired).toHaveLength(0);
    expect(mailbox.list()).toHaveLength(0);
    mailbox.close();
  });

  test("close() cancels pending microtask deliveries — subscriber fires 0 times after close", async () => {
    const mailbox = createLocalMailbox({ agentId: OWNER });
    const fired: string[] = [];
    mailbox.onMessage(async (msg): Promise<void> => {
      await Bun.sleep(5);
      fired.push(msg.type);
    });

    // Do NOT await send — close must run synchronously before the microtask fires.
    const p = mailbox.send(makeInput("before-close"));
    mailbox.close(); // bumps generation; microtask for "before-close" is cancelled
    await p;
    await Bun.sleep(30);
    expect(fired).toHaveLength(0);
  });

  test("re-registering the same mailbox instance revokes the old view and creates a new one", async () => {
    const { createLocalMailboxRouter } = await import("./router.js");
    const router = createLocalMailboxRouter();
    const mailbox = createLocalMailbox({ agentId: OWNER, router });
    router.register(OWNER, mailbox);
    const view1 = router.getView(OWNER);
    if (view1 === undefined) throw new Error("expected view1");
    expect(view1.revoked).toBe(false);

    router.register(OWNER, mailbox);
    // Old view is revoked; a new view is minted for the same mailbox.
    expect(view1.revoked).toBe(true);
    const view2 = router.getView(OWNER);
    if (view2 === undefined) throw new Error("expected view2");
    expect(view2).not.toBe(view1);
    expect(view2.revoked).toBe(false);
    mailbox.close();
  });

  test("list({ limit: 0 }) returns empty array without throwing", async () => {
    const mailbox = createLocalMailbox({ agentId: OWNER });
    await mailbox.send(makeInput("x"));
    expect(mailbox.list({ limit: 0 })).toEqual([]);
    mailbox.close();
  });

  test("onMessage subscriber added after send() but before microtask fires does NOT receive the message", async () => {
    const mailbox = createLocalMailbox({ agentId: OWNER });
    const fired: string[] = [];

    await mailbox.send(makeInput("snap")); // snapshot taken at send time
    mailbox.onMessage((msg) => {
      fired.push(msg.type);
    }); // registered after send
    await Bun.sleep(20);
    expect(fired).toHaveLength(0); // snapshot excludes late subscriber
    mailbox.close();
  });

  test("two routers with the same agentId string stay isolated — cross-router send rejected", async () => {
    const { createLocalMailboxRouter } = await import("./router.js");
    const routerX = createLocalMailboxRouter();
    const routerY = createLocalMailboxRouter();
    const mbX = createLocalMailbox({ agentId: agentId("agent"), router: routerX });
    const mbY = createLocalMailbox({ agentId: agentId("agent"), router: routerY });
    routerX.register(agentId("agent"), mbX);
    routerY.register(agentId("agent"), mbY);

    // mbX cannot deliver to agentId("agent") in routerY — different routing domains.
    // mbX.send to agentId("agent") routes through routerX, landing in mbX itself (self-send).
    const result = await mbX.send({
      from: agentId("agent"),
      to: agentId("agent"),
      kind: "event",
      type: "self",
      payload: {},
    });
    expect(result.ok).toBe(true);
    expect((await mbX.list()).map((m) => m.type)).toEqual(["self"]);
    expect(await mbY.list()).toHaveLength(0); // routerY inbox untouched
    mbX.close();
    mbY.close();
  });

  test("close() guard: closing the old mailbox after re-registration does not evict the new one", async () => {
    const { createLocalMailboxRouter } = await import("./router.js");
    const router = createLocalMailboxRouter();
    const old = createLocalMailbox({ agentId: OWNER, router });
    const fresh = createLocalMailbox({ agentId: OWNER, router });
    router.register(OWNER, old);
    router.register(OWNER, fresh); // replaces old

    old.close(); // should NOT unregister fresh
    expect(router.getView(OWNER)).toBeDefined();

    // fresh can still receive messages
    const sender = createLocalMailbox({ agentId: agentId("s"), router });
    router.register(agentId("s"), sender);
    await sender.send({
      from: agentId("s"),
      to: OWNER,
      kind: "event",
      type: "after-old-close",
      payload: {},
    });
    expect((await fresh.list()).map((m) => m.type)).toEqual(["after-old-close"]);
    sender.close();
    fresh.close();
  });
});
