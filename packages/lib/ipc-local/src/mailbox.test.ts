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
  test("FIFO eviction when at capacity", async () => {
    const mailbox = createLocalMailbox({ agentId: OWNER, maxMessages: 3 });
    for (const i of [1, 2, 3, 4]) {
      await mailbox.send(makeInput(`msg-${i}`));
    }
    const msgs = await mailbox.list();
    expect(msgs).toHaveLength(3);
    expect(msgs[0]?.type).toBe("msg-2");
    expect(msgs[1]?.type).toBe("msg-3");
    expect(msgs[2]?.type).toBe("msg-4");
    mailbox.close();
  });

  test("close clears messages and subscribers", async () => {
    const mailbox = createLocalMailbox({ agentId: OWNER });
    await mailbox.send(makeInput("test"));
    mailbox.close();
    const msgs = await mailbox.list();
    expect(msgs).toHaveLength(0);
  });

  test("microtask dispatch delivers after current task", async () => {
    const mailbox = createLocalMailbox({ agentId: OWNER });
    const received: string[] = [];
    mailbox.onMessage((msg) => {
      received.push(msg.type);
    });
    await mailbox.send(makeInput("deferred"));
    await Bun.sleep(5);
    expect(received).toHaveLength(1);
    expect(received[0]).toBe("deferred");
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
});
