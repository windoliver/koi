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

  test("capability overrides merge with defaults", () => {
    const { adapter } = createMockChannel({
      capabilities: { images: true },
    });
    expect(adapter.capabilities.images).toBe(true);
    expect(adapter.capabilities.text).toBe(true);
  });
});
