import { describe, expect, test } from "bun:test";
import type { InboundMessage } from "@koi/core";
import { createMockChannel } from "./create-mock-channel.js";

const inbound: InboundMessage = {
  content: [{ kind: "text", text: "hi" }],
  senderId: "alice",
  timestamp: 0,
};

describe("createMockChannel", () => {
  test("captures sent messages", async () => {
    const { adapter, sent } = createMockChannel();
    await adapter.send({ content: [{ kind: "text", text: "out" }] });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.content[0]).toEqual({ kind: "text", text: "out" });
  });

  test("captures status updates", async () => {
    const { adapter, statuses } = createMockChannel();
    await adapter.sendStatus?.({ kind: "processing", turnIndex: 0 });
    expect(statuses).toHaveLength(1);
    expect(statuses[0]?.kind).toBe("processing");
  });

  test("connect/disconnect toggles connected()", async () => {
    const { adapter, connected } = createMockChannel();
    expect(connected()).toBe(false);
    await adapter.connect();
    expect(connected()).toBe(true);
    await adapter.disconnect();
    expect(connected()).toBe(false);
  });

  test("receive dispatches to onMessage handler", async () => {
    const { adapter, receive } = createMockChannel();
    const received: InboundMessage[] = [];
    adapter.onMessage(async (msg: InboundMessage) => {
      received.push(msg);
    });
    await receive(inbound);
    expect(received).toHaveLength(1);
  });

  test("receive throws without a handler", async () => {
    const { receive } = createMockChannel();
    await expect(receive(inbound)).rejects.toThrow(/before onMessage/i);
  });

  test("unsubscribe removes the handler", async () => {
    const { adapter, receive } = createMockChannel();
    const unsub = adapter.onMessage(async () => {});
    unsub();
    await expect(receive(inbound)).rejects.toThrow(/before onMessage/i);
  });

  test("multiple subscribers all receive fan-out delivery", async () => {
    const { adapter, receive } = createMockChannel();
    const hits: number[] = [];
    adapter.onMessage(async () => {
      hits.push(1);
    });
    adapter.onMessage(async () => {
      hits.push(2);
    });
    adapter.onMessage(async () => {
      hits.push(3);
    });
    await receive(inbound);
    expect(hits.sort()).toEqual([1, 2, 3]);
  });

  test("unsubscribe is per-registration and idempotent", async () => {
    const { adapter, receive } = createMockChannel();
    const a: InboundMessage[] = [];
    const b: InboundMessage[] = [];
    const unsubA = adapter.onMessage(async (msg: InboundMessage) => {
      a.push(msg);
    });
    adapter.onMessage(async (msg: InboundMessage) => {
      b.push(msg);
    });
    unsubA();
    unsubA(); // idempotent — double-unsubscribe must not throw or affect `b`
    await receive(inbound);
    expect(a).toHaveLength(0);
    expect(b).toHaveLength(1);
  });

  test("same function registered twice produces two independent subscriptions", async () => {
    const { adapter, receive } = createMockChannel();
    const hits: number[] = [];
    const fn = async (): Promise<void> => {
      hits.push(1);
    };
    const unsub1 = adapter.onMessage(fn);
    adapter.onMessage(fn); // duplicate registration
    await receive(inbound);
    expect(hits).toHaveLength(2);

    // Unsubscribing one must leave the other active.
    hits.length = 0;
    unsub1();
    await receive(inbound);
    expect(hits).toHaveLength(1);
  });

  test("throwing async handler: fan-out continues, receive() resolves, failure recorded (default)", async () => {
    const { adapter, receive, handlerErrors } = createMockChannel();
    const hits: string[] = [];
    adapter.onMessage(async () => {
      throw new Error("boom");
    });
    adapter.onMessage(async () => {
      hits.push("ok");
    });

    // Default matches production: receive() resolves, siblings still run.
    await receive(inbound);
    expect(hits).toEqual(["ok"]);

    // Failures are still observable out-of-band.
    expect(handlerErrors).toHaveLength(1);
    expect((handlerErrors[0]?.error as Error).message).toBe("boom");
    expect(handlerErrors[0]?.message).toBe(inbound);
  });

  test("synchronously-throwing handler aborts dispatch (production parity)", async () => {
    // Production channel-base dispatch uses handlers.map((h) => h.fn(message))
    // directly, so a non-async handler that throws synchronously will
    // throw out of Array.map before Promise.allSettled runs. The mock
    // intentionally preserves this behavior so tests reflect production.
    const { adapter, receive } = createMockChannel();
    const hits: string[] = [];
    adapter.onMessage(((): Promise<void> => {
      throw new Error("sync boom");
    }) as unknown as Parameters<typeof adapter.onMessage>[0]);
    adapter.onMessage(async () => {
      hits.push("ok");
    });

    // Sync throw escapes receive() — this mirrors production.
    await expect(receive(inbound)).rejects.toThrow(/sync boom/);
    // The sibling registered AFTER the bad handler never runs, because
    // Array.map aborted before dispatching to it. This is the exact
    // production behavior; test it explicitly so future refactors do
    // not silently diverge.
    expect(hits).toEqual([]);
  });

  test("failFastOnHandlerError: true makes receive() reject with AggregateError", async () => {
    const { adapter, receive, handlerErrors } = createMockChannel({
      failFastOnHandlerError: true,
    });
    const hits: string[] = [];
    adapter.onMessage(async () => {
      throw new Error("boom");
    });
    adapter.onMessage(async () => {
      hits.push("ok");
    });

    await expect(receive(inbound)).rejects.toBeInstanceOf(AggregateError);
    // Siblings still ran before the rejection surfaced.
    expect(hits).toEqual(["ok"]);
    expect(handlerErrors).toHaveLength(1);
  });

  test("clean runs leave handlerErrors empty", async () => {
    const { adapter, receive, handlerErrors } = createMockChannel();
    adapter.onMessage(async () => {});
    await receive(inbound);
    expect(handlerErrors).toHaveLength(0);
  });

  test("capability overrides merge with defaults", () => {
    const { adapter } = createMockChannel({
      capabilities: { images: true },
    });
    expect(adapter.capabilities.images).toBe(true);
    expect(adapter.capabilities.text).toBe(true);
  });
});
