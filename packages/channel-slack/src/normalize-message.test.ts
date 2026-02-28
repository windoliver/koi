import { describe, expect, test } from "bun:test";
import { normalizeMessage, resolveThreadId } from "./normalize-message.js";
import { createMockMessageEvent } from "./test-helpers.js";

describe("normalizeMessage", () => {
  const BOT_USER_ID = "B001";

  test("normalizes text message", () => {
    const event = createMockMessageEvent({ text: "hello world", user: "U123" });
    const result = normalizeMessage(event, BOT_USER_ID);

    expect(result).not.toBeNull();
    expect(result?.content).toEqual([{ kind: "text", text: "hello world" }]);
    expect(result?.senderId).toBe("U123");
    expect(result?.threadId).toBe("C456");
    expect(result?.timestamp).toBeGreaterThan(0);
  });

  test("returns null for bot's own messages", () => {
    const event = createMockMessageEvent({ user: BOT_USER_ID });
    expect(normalizeMessage(event, BOT_USER_ID)).toBeNull();
  });

  test("returns null for message_changed subtype", () => {
    const event = createMockMessageEvent({ subtype: "message_changed" });
    expect(normalizeMessage(event, BOT_USER_ID)).toBeNull();
  });

  test("allows file_share subtype", () => {
    const event = createMockMessageEvent({
      subtype: "file_share",
      text: "",
      files: [
        {
          id: "F1",
          name: "doc.pdf",
          mimetype: "application/pdf",
          url_private: "https://files.slack.com/doc.pdf",
        },
      ],
    });
    const result = normalizeMessage(event, BOT_USER_ID);
    expect(result).not.toBeNull();
    expect(result?.content).toHaveLength(1);
    expect(result?.content[0]?.kind).toBe("file");
  });

  test("normalizes image file as ImageBlock", () => {
    const event = createMockMessageEvent({
      text: "",
      files: [
        {
          id: "F1",
          name: "photo.png",
          mimetype: "image/png",
          url_private: "https://files.slack.com/photo.png",
        },
      ],
    });
    const result = normalizeMessage(event, BOT_USER_ID);
    expect(result?.content[0]).toEqual({
      kind: "image",
      url: "https://files.slack.com/photo.png",
      alt: "photo.png",
    });
  });

  test("normalizes non-image file as FileBlock", () => {
    const event = createMockMessageEvent({
      text: "",
      files: [
        {
          id: "F1",
          name: "doc.pdf",
          mimetype: "application/pdf",
          url_private: "https://files.slack.com/doc.pdf",
        },
      ],
    });
    const result = normalizeMessage(event, BOT_USER_ID);
    expect(result?.content[0]).toEqual({
      kind: "file",
      url: "https://files.slack.com/doc.pdf",
      mimeType: "application/pdf",
      name: "doc.pdf",
    });
  });

  test("skips files without url_private", () => {
    const event = createMockMessageEvent({
      text: "",
      files: [{ id: "F1", name: "missing.pdf" }],
    });
    expect(normalizeMessage(event, BOT_USER_ID)).toBeNull();
  });

  test("returns null for empty message (no text, no files)", () => {
    const event = createMockMessageEvent({ text: "" });
    expect(normalizeMessage(event, BOT_USER_ID)).toBeNull();
  });

  test("uses thread_ts in threadId when present", () => {
    const event = createMockMessageEvent({ thread_ts: "1234567890.000002" });
    const result = normalizeMessage(event, BOT_USER_ID);
    expect(result?.threadId).toBe("C456:1234567890.000002");
  });

  test("uses 'unknown' senderId when user is undefined", () => {
    const event = createMockMessageEvent({ user: undefined });
    const result = normalizeMessage(event, BOT_USER_ID);
    expect(result?.senderId).toBe("unknown");
  });

  test("allows thread_broadcast subtype", () => {
    const event = createMockMessageEvent({ subtype: "thread_broadcast" });
    const result = normalizeMessage(event, BOT_USER_ID);
    expect(result).not.toBeNull();
  });
});

describe("resolveThreadId", () => {
  test("returns channel only when no thread_ts", () => {
    expect(resolveThreadId("C456")).toBe("C456");
  });

  test("returns channel:thread_ts when thread_ts present", () => {
    expect(resolveThreadId("C456", "123.456")).toBe("C456:123.456");
  });
});
