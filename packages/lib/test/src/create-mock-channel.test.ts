import { describe, expect, test } from "bun:test";
import type { InboundMessage } from "@koi/core";
import {
  createMockChannel,
  type MockChannelConfig,
  type MockChannelResult,
} from "./create-mock-channel.js";

const inbound: InboundMessage = {
  content: [{ kind: "text", text: "hi" }],
  senderId: "alice",
  timestamp: 0,
};

/** Create a mock channel and connect() it immediately — the common case. */
async function connectedMock(config?: MockChannelConfig): Promise<MockChannelResult> {
  const mock = createMockChannel(config);
  await mock.adapter.connect();
  return mock;
}

describe("createMockChannel — basic capture", () => {
  test("captures sent messages (raw + rendered)", async () => {
    const { adapter, sent, sentRendered } = await connectedMock();
    await adapter.send({ content: [{ kind: "text", text: "out" }] });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.content[0]).toEqual({ kind: "text", text: "out" });
    expect(sentRendered).toHaveLength(1);
  });

  test("captures status updates", async () => {
    const { adapter, statuses } = await connectedMock();
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
});

describe("createMockChannel — inbound dispatch", () => {
  test("receive dispatches to onMessage handler", async () => {
    const { adapter, receive } = await connectedMock();
    const received: InboundMessage[] = [];
    adapter.onMessage(async (msg: InboundMessage) => {
      received.push(msg);
    });
    await receive(inbound);
    expect(received).toHaveLength(1);
  });

  test("receive throws without a handler (only when connected)", async () => {
    const { receive } = await connectedMock();
    await expect(receive(inbound)).rejects.toThrow(/before onMessage/i);
  });

  test("receive() before ever connecting throws loudly (setup mistake)", async () => {
    // A never-connected mock surfaces a clear setup error so a missing
    // `await adapter.connect()` in test setup fails fast rather than
    // masking a broken message-handling path.
    const { receive } = createMockChannel();
    await expect(receive(inbound)).rejects.toThrow(/before adapter\.connect/i);
  });

  test("receive() after explicit disconnect silently drops (teardown parity)", async () => {
    // Once the test has established a valid connection and then torn
    // it down, inbound messages mirror production silent-drop behavior.
    const { adapter, receive } = await connectedMock();
    adapter.onMessage(async () => {});
    await adapter.disconnect();
    // Must not throw — matches production.
    await receive(inbound);
  });

  test("unsubscribe removes the handler", async () => {
    const { adapter, receive } = await connectedMock();
    const unsub = adapter.onMessage(async () => {});
    unsub();
    await expect(receive(inbound)).rejects.toThrow(/before onMessage/i);
  });

  test("multiple subscribers all receive fan-out delivery", async () => {
    const { adapter, receive } = await connectedMock();
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
    const { adapter, receive } = await connectedMock();
    const a: InboundMessage[] = [];
    const b: InboundMessage[] = [];
    const unsubA = adapter.onMessage(async (msg: InboundMessage) => {
      a.push(msg);
    });
    adapter.onMessage(async (msg: InboundMessage) => {
      b.push(msg);
    });
    unsubA();
    unsubA();
    await receive(inbound);
    expect(a).toHaveLength(0);
    expect(b).toHaveLength(1);
  });

  test("same function registered twice produces two independent subscriptions", async () => {
    const { adapter, receive } = await connectedMock();
    const hits: number[] = [];
    const fn = async (): Promise<void> => {
      hits.push(1);
    };
    const unsub1 = adapter.onMessage(fn);
    adapter.onMessage(fn);
    await receive(inbound);
    expect(hits).toHaveLength(2);

    hits.length = 0;
    unsub1();
    await receive(inbound);
    expect(hits).toHaveLength(1);
  });
});

describe("createMockChannel — handler failures", () => {
  test("throwing async handler: fan-out continues, receive() resolves, failure recorded (default)", async () => {
    const { adapter, receive, handlerErrors } = await connectedMock();
    const hits: string[] = [];
    adapter.onMessage(async () => {
      throw new Error("boom");
    });
    adapter.onMessage(async () => {
      hits.push("ok");
    });

    await receive(inbound);
    expect(hits).toEqual(["ok"]);
    expect(handlerErrors).toHaveLength(1);
    expect((handlerErrors[0]?.error as Error).message).toBe("boom");
    expect(handlerErrors[0]?.message).toBe(inbound);
  });

  test("synchronously-throwing handler aborts dispatch (production parity)", async () => {
    const { adapter, receive } = await connectedMock();
    const hits: string[] = [];
    adapter.onMessage(((): Promise<void> => {
      throw new Error("sync boom");
    }) as unknown as Parameters<typeof adapter.onMessage>[0]);
    adapter.onMessage(async () => {
      hits.push("ok");
    });

    await expect(receive(inbound)).rejects.toThrow(/sync boom/);
    expect(hits).toEqual([]);
  });

  test("failFastOnHandlerError: true makes receive() reject with AggregateError", async () => {
    const { adapter, receive, handlerErrors } = await connectedMock({
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
    expect(hits).toEqual(["ok"]);
    expect(handlerErrors).toHaveLength(1);
  });

  test("failFastOnHandlerError survives a disconnect race during dispatch", async () => {
    // Regression: a handler that triggers a disconnect mid-dispatch
    // must not silently downgrade the opted-in rejection to a
    // side-channel entry. The fail-fast mode is supposed to make
    // handler failures loud — even across a concurrent disconnect.
    const { adapter, receive, handlerErrors } = await connectedMock({
      failFastOnHandlerError: true,
    });
    adapter.onMessage(async () => {
      // Simulate a teardown racing with dispatch.
      await adapter.disconnect();
      throw new Error("boom after disconnect");
    });
    adapter.onMessage(async () => {
      // unrelated sibling that runs before the thrower settles
    });

    await expect(receive(inbound)).rejects.toBeInstanceOf(AggregateError);
    expect(handlerErrors).toHaveLength(1);
  });

  test("clean runs leave handlerErrors empty", async () => {
    const { adapter, receive, handlerErrors } = await connectedMock();
    adapter.onMessage(async () => {});
    await receive(inbound);
    expect(handlerErrors).toHaveLength(0);
  });
});

describe("createMockChannel — lifecycle gating (production parity)", () => {
  test("send() rejects while disconnected", async () => {
    const { adapter } = createMockChannel();
    await expect(adapter.send({ content: [{ kind: "text", text: "out" }] })).rejects.toThrow(
      /not connected/i,
    );
  });

  test("send() rejects after disconnect", async () => {
    const { adapter } = await connectedMock();
    await adapter.disconnect();
    await expect(adapter.send({ content: [{ kind: "text", text: "out" }] })).rejects.toThrow(
      /not connected/i,
    );
  });

  test("sendStatus() is a silent no-op while disconnected", async () => {
    const { adapter, statuses } = createMockChannel();
    // No throw, no status captured.
    await adapter.sendStatus?.({ kind: "processing", turnIndex: 0 });
    expect(statuses).toHaveLength(0);
  });

  test("receive() throws on a never-connected channel even with a handler", async () => {
    // Setup mistakes must stay loud: never-connected means setup bug,
    // regardless of whether a handler was registered or not.
    const { adapter, receive } = createMockChannel();
    adapter.onMessage(async () => {});
    await expect(receive(inbound)).rejects.toThrow(/before adapter\.connect/i);
  });

  test("receive() drops inbound messages after disconnect", async () => {
    const { adapter, receive } = await connectedMock();
    const hits: InboundMessage[] = [];
    adapter.onMessage(async (msg: InboundMessage) => {
      hits.push(msg);
    });
    await adapter.disconnect();
    await receive(inbound);
    expect(hits).toHaveLength(0);
  });

  test("bypassLifecycleChecks: true disables all gating", async () => {
    const { adapter, receive, sent, statuses } = createMockChannel({
      bypassLifecycleChecks: true,
    });
    const hits: InboundMessage[] = [];
    adapter.onMessage(async (msg: InboundMessage) => {
      hits.push(msg);
    });
    // Send while disconnected succeeds.
    await adapter.send({ content: [{ kind: "text", text: "out" }] });
    expect(sent).toHaveLength(1);
    // sendStatus captures while disconnected.
    await adapter.sendStatus?.({ kind: "processing", turnIndex: 0 });
    expect(statuses).toHaveLength(1);
    // receive dispatches while disconnected.
    await receive(inbound);
    expect(hits).toHaveLength(1);
  });
});

describe("createMockChannel — content rendering", () => {
  test("sent preserves raw blocks; sentRendered downgrades for unsupported capabilities", async () => {
    const { adapter, sent, sentRendered } = await connectedMock();
    await adapter.send({
      content: [
        { kind: "text", text: "see below" },
        { kind: "image", url: "https://example.com/cat.png", alt: "a cat" },
      ],
    });

    // sent[] preserves exactly what the caller passed.
    expect(sent[0]?.content[1]?.kind).toBe("image");
    // sentRendered[] is the post-renderBlocks wire form.
    expect(sentRendered[0]?.content[1]).toEqual({ kind: "text", text: "[Image: a cat]" });
  });

  test("file blocks downgrade to text fallback in sentRendered", async () => {
    const { adapter, sentRendered } = await connectedMock();
    await adapter.send({
      content: [
        { kind: "file", url: "https://ex.com/a.pdf", mimeType: "application/pdf", name: "a.pdf" },
      ],
    });
    expect(sentRendered[0]?.content[0]).toEqual({ kind: "text", text: "[File: a.pdf]" });
  });

  test("button blocks downgrade to text fallback in sentRendered", async () => {
    const { adapter, sentRendered } = await connectedMock();
    await adapter.send({
      content: [{ kind: "button", label: "Click me", action: "do-it" }],
    });
    expect(sentRendered[0]?.content[0]).toEqual({ kind: "text", text: "[Click me]" });
  });

  test("unsupported blocks pass through in sentRendered when capability is true", async () => {
    const { adapter, sentRendered } = await connectedMock({
      capabilities: { images: true, files: true, buttons: true },
    });
    await adapter.send({
      content: [{ kind: "image", url: "https://example.com/cat.png", alt: "a cat" }],
    });
    expect(sentRendered[0]?.content[0]?.kind).toBe("image");
  });
});

describe("createMockChannel — configuration", () => {
  test("capability overrides merge with defaults", () => {
    const { adapter } = createMockChannel({
      capabilities: { images: true },
    });
    expect(adapter.capabilities.images).toBe(true);
    expect(adapter.capabilities.text).toBe(true);
  });
});
