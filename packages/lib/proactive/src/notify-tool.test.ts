import { describe, expect, test } from "bun:test";
import type { ChannelAdapter, JsonObject } from "@koi/core";
import { createNotifyTool } from "./notify-tool.js";

function stubAdapter(overrides: Partial<ChannelAdapter> = {}): ChannelAdapter {
  return {
    name: "stub",
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
    send: async () => {},
    onMessage: () => () => {},
    ...overrides,
  };
}

describe("notify tool", () => {
  test("returns ok:false with sorted available_channels for unknown channel", async () => {
    const channels = new Map<string, ChannelAdapter>([
      ["slack", stubAdapter({ name: "slack" })],
      ["email", stubAdapter({ name: "email" })],
    ]);
    const tool = createNotifyTool({
      resolveChannel: (n) => channels.get(n) ?? undefined,
      names: () => [...channels.keys()],
    });
    const result = (await tool.execute({ channel: "telegram", text: "hi" })) as JsonObject;
    expect(result).toEqual({
      ok: false,
      error: "unknown channel: telegram",
      available_channels: ["email", "slack"],
    });
  });
});
