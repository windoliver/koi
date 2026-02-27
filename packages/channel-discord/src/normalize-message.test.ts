/**
 * Unit tests for normalizeMessage() — Discord Message → InboundMessage.
 */

import { describe, expect, test } from "bun:test";
import type { Message } from "discord.js";
import { normalizeMessage } from "./normalize-message.js";
import { createMockMessage } from "./test-helpers.js";

const BOT_USER_ID = "bot-123";

/** Casts mock to Message for the normalizer. */
function asMessage(mock: ReturnType<typeof createMockMessage>): Message {
  return mock as unknown as Message;
}

describe("normalizeMessage — text messages", () => {
  test("returns TextBlock for plain text message", () => {
    const msg = createMockMessage({ content: "hello world" });
    const result = normalizeMessage(asMessage(msg), BOT_USER_ID);
    expect(result).not.toBeNull();
    expect(result?.content).toEqual([{ kind: "text", text: "hello world" }]);
  });

  test("sets senderId from author.id", () => {
    const msg = createMockMessage({ authorId: "user-456" });
    const result = normalizeMessage(asMessage(msg), BOT_USER_ID);
    expect(result?.senderId).toBe("user-456");
  });

  test("sets threadId as guildId:channelId", () => {
    const msg = createMockMessage({ guildId: "g1", channelId: "c1" });
    const result = normalizeMessage(asMessage(msg), BOT_USER_ID);
    expect(result?.threadId).toBe("g1:c1");
  });

  test("sets threadId as dm:userId for DM messages", () => {
    const msg = createMockMessage({ guildId: null, authorId: "user-789" });
    const result = normalizeMessage(asMessage(msg), BOT_USER_ID);
    expect(result?.threadId).toBe("dm:user-789");
  });

  test("sets timestamp from createdTimestamp", () => {
    const ts = 1700000000000;
    const msg = createMockMessage({ createdTimestamp: ts });
    const result = normalizeMessage(asMessage(msg), BOT_USER_ID);
    expect(result?.timestamp).toBe(ts);
  });
});

describe("normalizeMessage — bot filtering", () => {
  test("returns null for bot's own messages", () => {
    const msg = createMockMessage({ authorId: BOT_USER_ID, authorBot: true });
    const result = normalizeMessage(asMessage(msg), BOT_USER_ID);
    expect(result).toBeNull();
  });

  test("does not filter other bot messages", () => {
    const msg = createMockMessage({ authorId: "other-bot-456", authorBot: true });
    const result = normalizeMessage(asMessage(msg), BOT_USER_ID);
    expect(result).not.toBeNull();
  });
});

describe("normalizeMessage — attachments", () => {
  test("returns ImageBlock for image attachments", () => {
    const attachments = new Map([
      [
        "a1",
        {
          id: "a1",
          url: "https://cdn.discord.com/img.png",
          name: "photo.png",
          contentType: "image/png",
          size: 1024,
        },
      ],
    ]);
    const msg = createMockMessage({ content: "", attachments });
    const result = normalizeMessage(asMessage(msg), BOT_USER_ID);
    expect(result?.content[0]).toMatchObject({
      kind: "image",
      url: "https://cdn.discord.com/img.png",
      alt: "photo.png",
    });
  });

  test("returns FileBlock for non-image attachments", () => {
    const attachments = new Map([
      [
        "a1",
        {
          id: "a1",
          url: "https://cdn.discord.com/doc.pdf",
          name: "report.pdf",
          contentType: "application/pdf",
          size: 2048,
        },
      ],
    ]);
    const msg = createMockMessage({ content: "", attachments });
    const result = normalizeMessage(asMessage(msg), BOT_USER_ID);
    expect(result?.content[0]).toMatchObject({
      kind: "file",
      url: "https://cdn.discord.com/doc.pdf",
      mimeType: "application/pdf",
      name: "report.pdf",
    });
  });

  test("uses application/octet-stream when contentType is null", () => {
    const attachments = new Map([
      [
        "a1",
        {
          id: "a1",
          url: "https://cdn.discord.com/unknown",
          name: "mystery.bin",
          contentType: null,
          size: 512,
        },
      ],
    ]);
    const msg = createMockMessage({ content: "", attachments });
    const result = normalizeMessage(asMessage(msg), BOT_USER_ID);
    expect(result?.content[0]).toMatchObject({
      kind: "file",
      mimeType: "application/octet-stream",
    });
  });

  test("combines text and attachments", () => {
    const attachments = new Map([
      [
        "a1",
        {
          id: "a1",
          url: "https://cdn.discord.com/img.jpg",
          name: "photo.jpg",
          contentType: "image/jpeg",
          size: 512,
        },
      ],
    ]);
    const msg = createMockMessage({ content: "check this out", attachments });
    const result = normalizeMessage(asMessage(msg), BOT_USER_ID);
    expect(result?.content).toHaveLength(2);
    expect(result?.content[0]).toMatchObject({ kind: "text", text: "check this out" });
    expect(result?.content[1]).toMatchObject({ kind: "image" });
  });
});

describe("normalizeMessage — stickers", () => {
  test("returns CustomBlock for stickers", () => {
    const stickers = new Map([["s1", { id: "s1", name: "cool_sticker", format: 1 }]]);
    const msg = createMockMessage({ content: "", stickers });
    const result = normalizeMessage(asMessage(msg), BOT_USER_ID);
    expect(result?.content[0]).toMatchObject({
      kind: "custom",
      type: "discord:sticker",
      data: { id: "s1", name: "cool_sticker", format: 1 },
    });
  });
});

describe("normalizeMessage — empty messages", () => {
  test("returns null for messages with no content or attachments", () => {
    const msg = createMockMessage({ content: "" });
    const result = normalizeMessage(asMessage(msg), BOT_USER_ID);
    expect(result).toBeNull();
  });
});

describe("normalizeMessage — message references (replies)", () => {
  test("sets metadata.replyToMessageId when message is a reply", () => {
    const msg = createMockMessage({ content: "I agree!", replyToMessageId: "original-msg-123" });
    const result = normalizeMessage(asMessage(msg), BOT_USER_ID);
    expect(result?.metadata).toMatchObject({ replyToMessageId: "original-msg-123" });
  });

  test("does not set metadata when message is not a reply", () => {
    const msg = createMockMessage({ content: "standalone message" });
    const result = normalizeMessage(asMessage(msg), BOT_USER_ID);
    expect(result?.metadata).toBeUndefined();
  });
});

describe("normalizeMessage — thread messages", () => {
  test("sets threadId for thread messages", () => {
    const msg = createMockMessage({
      guildId: "g1",
      channelId: "thread-123",
      isThread: true,
    });
    const result = normalizeMessage(asMessage(msg), BOT_USER_ID);
    expect(result?.threadId).toBe("g1:thread-123");
  });
});
