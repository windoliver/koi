/**
 * Unit tests for discordSend() and splitText().
 */

import { describe, expect, mock, test } from "bun:test";
import { splitText } from "@koi/channel-base";
import type { DiscordSendTarget } from "./platform-send.js";
import { discordSend } from "./platform-send.js";

// ---------------------------------------------------------------------------
// Mock channel factory
// ---------------------------------------------------------------------------

function createMockChannel(): DiscordSendTarget & { readonly send: ReturnType<typeof mock> } {
  return {
    send: mock(async () => ({})),
    sendTyping: mock(async () => {}),
  };
}

function makeGetChannel(
  channel: DiscordSendTarget,
): (threadId: string) => DiscordSendTarget | undefined {
  return () => channel;
}

// ---------------------------------------------------------------------------
// discordSend — basic behavior
// ---------------------------------------------------------------------------

describe("discordSend — basic", () => {
  test("throws when threadId is undefined", async () => {
    const channel = createMockChannel();
    await expect(
      discordSend(makeGetChannel(channel), { content: [{ kind: "text", text: "hi" }] }),
    ).rejects.toThrow("threadId is required");
  });

  test("silently returns when channel is not found", async () => {
    await discordSend(() => undefined, {
      content: [{ kind: "text", text: "hi" }],
      threadId: "g1:c1",
    });
    // No error thrown — just a warning logged
  });

  test("sends text content", async () => {
    const channel = createMockChannel();
    await discordSend(makeGetChannel(channel), {
      content: [{ kind: "text", text: "hello world" }],
      threadId: "g1:c1",
    });
    expect(channel.send).toHaveBeenCalledTimes(1);
    expect(channel.send.mock.calls[0]?.[0]).toMatchObject({ content: "hello world" });
  });

  test("merges adjacent text blocks", async () => {
    const channel = createMockChannel();
    await discordSend(makeGetChannel(channel), {
      content: [
        { kind: "text", text: "line 1" },
        { kind: "text", text: "line 2" },
      ],
      threadId: "g1:c1",
    });
    expect(channel.send).toHaveBeenCalledTimes(1);
    expect(channel.send.mock.calls[0]?.[0]).toMatchObject({ content: "line 1\nline 2" });
  });

  test("sends empty content without calling send", async () => {
    const channel = createMockChannel();
    await discordSend(makeGetChannel(channel), {
      content: [],
      threadId: "g1:c1",
    });
    expect(channel.send).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// discordSend — embeds and components
// ---------------------------------------------------------------------------

describe("discordSend — embeds and components", () => {
  test("sends image as embed", async () => {
    const channel = createMockChannel();
    await discordSend(makeGetChannel(channel), {
      content: [{ kind: "image", url: "https://example.com/img.png", alt: "My image" }],
      threadId: "g1:c1",
    });
    expect(channel.send).toHaveBeenCalledTimes(1);
    const payload = channel.send.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(payload.embeds).toBeDefined();
    expect((payload.embeds as unknown[])[0]).toMatchObject({
      image: { url: "https://example.com/img.png" },
    });
  });

  test("sends file as attachment", async () => {
    const channel = createMockChannel();
    await discordSend(makeGetChannel(channel), {
      content: [
        {
          kind: "file",
          url: "https://example.com/doc.pdf",
          mimeType: "application/pdf",
          name: "doc.pdf",
        },
      ],
      threadId: "g1:c1",
    });
    expect(channel.send).toHaveBeenCalledTimes(1);
    const payload = channel.send.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(payload.files).toBeDefined();
  });

  test("sends button as action row component", async () => {
    const channel = createMockChannel();
    await discordSend(makeGetChannel(channel), {
      content: [{ kind: "button", label: "Click me", action: "do_thing" }],
      threadId: "g1:c1",
    });
    expect(channel.send).toHaveBeenCalledTimes(1);
    const payload = channel.send.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(payload.components).toBeDefined();
  });

  test("sends discord:embed custom blocks", async () => {
    const channel = createMockChannel();
    await discordSend(makeGetChannel(channel), {
      content: [
        {
          kind: "custom",
          type: "discord:embed",
          data: { title: "Test Embed", color: 0x00ff00 },
        },
      ],
      threadId: "g1:c1",
    });
    expect(channel.send).toHaveBeenCalledTimes(1);
    const payload = channel.send.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(payload.embeds).toBeDefined();
    expect((payload.embeds as unknown[])[0]).toMatchObject({ title: "Test Embed" });
  });

  test("sends discord:action_row custom blocks", async () => {
    const channel = createMockChannel();
    await discordSend(makeGetChannel(channel), {
      content: [
        {
          kind: "custom",
          type: "discord:action_row",
          data: { type: 1, components: [{ type: 2, label: "Hi", custom_id: "hi" }] },
        },
      ],
      threadId: "g1:c1",
    });
    expect(channel.send).toHaveBeenCalledTimes(1);
    const payload = channel.send.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(payload.components).toBeDefined();
  });

  test("silently skips unknown custom blocks", async () => {
    const channel = createMockChannel();
    await discordSend(makeGetChannel(channel), {
      content: [{ kind: "custom", type: "unknown:thing", data: {} }],
      threadId: "g1:c1",
    });
    expect(channel.send).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// discordSend — batched payloads
// ---------------------------------------------------------------------------

describe("discordSend — batching", () => {
  test("batches text + embeds + components in single API call", async () => {
    const channel = createMockChannel();
    await discordSend(makeGetChannel(channel), {
      content: [
        { kind: "text", text: "hello" },
        { kind: "image", url: "https://example.com/img.png" },
        { kind: "button", label: "Click", action: "click" },
      ],
      threadId: "g1:c1",
    });
    expect(channel.send).toHaveBeenCalledTimes(1);
    const payload = channel.send.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(payload.content).toBe("hello");
    expect(payload.embeds).toBeDefined();
    expect(payload.components).toBeDefined();
  });

  test("overflow embeds causes additional message", async () => {
    const channel = createMockChannel();
    const embeds = Array.from({ length: 11 }, (_, i) => ({
      kind: "custom" as const,
      type: "discord:embed",
      data: { title: `Embed ${i}` },
    }));
    await discordSend(makeGetChannel(channel), {
      content: embeds,
      threadId: "g1:c1",
    });
    expect(channel.send).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// splitText
// ---------------------------------------------------------------------------

describe("splitText (via @koi/channel-base)", () => {
  test("returns single-element array for short text", () => {
    expect(splitText("hello", 2000)).toEqual(["hello"]);
  });

  test("splits at 2000-char boundary", () => {
    const text = "a".repeat(2001);
    const parts = splitText(text, 2000);
    expect(parts.length).toBe(2);
    expect(parts[0]?.length).toBeLessThanOrEqual(2000);
    expect(parts.join("")).toBe(text);
  });

  test("prefers splitting at newlines", () => {
    const text = `${"a".repeat(1990)}\n${"b".repeat(100)}`;
    const parts = splitText(text, 2000);
    expect(parts.length).toBe(2);
    expect(parts[0]?.endsWith("a")).toBe(true);
  });

  test("handles text with no newlines", () => {
    const text = "x".repeat(4001);
    const parts = splitText(text, 2000);
    expect(parts.length).toBe(3);
    for (const part of parts) {
      expect(part.length).toBeLessThanOrEqual(2000);
    }
  });

  test("returns single-element array for empty string", () => {
    // splitText is not called with empty strings (guarded in buildPayloads)
    // but should handle it gracefully
    expect(splitText("", 2000)).toEqual([""]);
  });
});
