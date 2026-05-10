import { describe, expect, test } from "bun:test";
import type { ChannelAdapter, JsonObject, OutboundMessage } from "@koi/core";
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

  test("forwards exact OutboundMessage shape on successful send", async () => {
    const sent: OutboundMessage[] = [];
    const slack = stubAdapter({
      name: "slack",
      send: async (m) => {
        sent.push(m);
      },
    });
    const tool = createNotifyTool({
      resolveChannel: (n) => (n === "slack" ? slack : undefined),
      names: () => ["slack"],
    });

    const result = await tool.execute({
      channel: "slack",
      text: "hello",
      thread_id: "T1",
      metadata: { priority: "high" },
    });

    expect(result).toEqual({ ok: true });
    expect(sent).toEqual([
      {
        content: [{ kind: "text", text: "hello" }],
        threadId: "T1",
        metadata: { priority: "high" },
      },
    ]);
  });

  test("omits threadId and metadata from outbound when not provided", async () => {
    const sent: OutboundMessage[] = [];
    const slack = stubAdapter({
      name: "slack",
      send: async (m) => {
        sent.push(m);
      },
    });
    const tool = createNotifyTool({
      resolveChannel: () => slack,
      names: () => ["slack"],
    });

    await tool.execute({ channel: "slack", text: "hi" });

    expect(sent).toHaveLength(1);
    expect(Object.keys(sent[0]!).sort()).toEqual(["content"]);
  });

  test("returns ok:false when adapter.send rejects, never throws", async () => {
    const slack = stubAdapter({
      name: "slack",
      send: async () => {
        throw new Error("network down");
      },
    });
    const tool = createNotifyTool({
      resolveChannel: () => slack,
      names: () => ["slack"],
    });

    const result = await tool.execute({ channel: "slack", text: "hi" });
    expect(result).toEqual({ ok: false, error: "network down" });
  });

  test("returns ok:false with default message when adapter throws non-Error", async () => {
    const slack = stubAdapter({
      name: "slack",
      send: async () => {
        throw "string thrown";
      },
    });
    const tool = createNotifyTool({
      resolveChannel: () => slack,
      names: () => ["slack"],
    });

    const result = await tool.execute({ channel: "slack", text: "hi" });
    expect(result).toEqual({ ok: false, error: "channel.send failed" });
  });

  test("rejects empty channel name at schema boundary", async () => {
    const tool = createNotifyTool({ resolveChannel: () => undefined, names: () => [] });
    const result = (await tool.execute({ channel: "", text: "hi" })) as {
      ok: boolean;
      error: string;
    };
    expect(result.ok).toBe(false);
    expect(result.error).toContain("channel");
  });

  test("rejects empty text at schema boundary", async () => {
    const tool = createNotifyTool({ resolveChannel: () => undefined, names: () => [] });
    const result = (await tool.execute({ channel: "slack", text: "" })) as {
      ok: boolean;
      error: string;
    };
    expect(result.ok).toBe(false);
    expect(result.error).toContain("text");
  });
});
