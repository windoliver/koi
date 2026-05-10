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
});
