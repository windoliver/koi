import { describe, expect, test } from "bun:test";
import type { ChannelAdapter, OutboundMessage } from "@koi/core";
import { createProactiveDelivery } from "./proactive-delivery.js";

function stubAdapter(name: string, send?: (m: OutboundMessage) => Promise<void>): ChannelAdapter {
  return {
    name,
    capabilities: {
      text: true,
      images: false,
      files: false,
      buttons: false,
      audio: false,
      video: false,
      threads: true,
      supportsA2ui: false,
    },
    connect: async () => {},
    disconnect: async () => {},
    send: send ?? (async () => {}),
    onMessage: () => () => {},
  };
}

describe("createProactiveDelivery", () => {
  test("returns no_channels when channel map is empty", async () => {
    const delivery = createProactiveDelivery({ channels: new Map() });
    const result = await delivery.send({
      priority: "normal",
      content: [{ kind: "text", text: "hi" }],
    });
    expect(result).toEqual({ ok: false, reason: "no_channels" });
  });

  test("high priority routes to preferredChannel", async () => {
    const sent: { channel: string; msg: OutboundMessage }[] = [];
    const slack = stubAdapter("slack", async (m) => { sent.push({ channel: "slack", msg: m }); });
    const email = stubAdapter("email", async (m) => { sent.push({ channel: "email", msg: m }); });
    const delivery = createProactiveDelivery({
      channels: new Map([["slack", slack], ["email", email]]),
      preferences: { preferredChannel: "email" },
    });

    const result = await delivery.send({
      priority: "high",
      content: [{ kind: "text", text: "hi" }],
    });

    expect(result).toEqual({ ok: true, delivered: ["email"] });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.channel).toBe("email");
    expect(sent[0]?.msg.content).toEqual([{ kind: "text", text: "hi" }]);
  });

  test("high priority falls back to first channel when no preferred", async () => {
    const sent: string[] = [];
    const slack = stubAdapter("slack", async () => { sent.push("slack"); });
    const email = stubAdapter("email", async () => { sent.push("email"); });
    const delivery = createProactiveDelivery({
      channels: new Map([["slack", slack], ["email", email]]),
    });

    const result = await delivery.send({
      priority: "high",
      content: [{ kind: "text", text: "hi" }],
    });

    expect(result).toEqual({ ok: true, delivered: ["slack"] });
    expect(sent).toEqual(["slack"]);
  });

  test("normal and low priority behave identically to high in Phase 3", async () => {
    const sent: string[] = [];
    const slack = stubAdapter("slack", async () => { sent.push("slack"); });
    const delivery = createProactiveDelivery({ channels: new Map([["slack", slack]]) });

    const r1 = await delivery.send({ priority: "normal", content: [{ kind: "text", text: "n" }] });
    const r2 = await delivery.send({ priority: "low", content: [{ kind: "text", text: "l" }] });

    expect(r1).toEqual({ ok: true, delivered: ["slack"] });
    expect(r2).toEqual({ ok: true, delivered: ["slack"] });
    expect(sent).toEqual(["slack", "slack"]);
  });

  test("threadId and metadata forwarded verbatim to OutboundMessage", async () => {
    const captured: OutboundMessage[] = [];
    const slack = stubAdapter("slack", async (m) => { captured.push(m); });
    const delivery = createProactiveDelivery({ channels: new Map([["slack", slack]]) });

    await delivery.send({
      priority: "normal",
      content: [{ kind: "text", text: "hi" }],
      threadId: "T1",
      metadata: { source: "composition" },
    });

    expect(captured).toHaveLength(1);
    expect(captured[0]).toEqual({
      content: [{ kind: "text", text: "hi" }],
      threadId: "T1",
      metadata: { source: "composition" },
    });
  });
});
