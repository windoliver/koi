/**
 * Unit tests for normalize.ts — Telegram Context → InboundMessage.
 *
 * Uses minimal Context stubs. All tests run against createNormalizer(token).
 */

import { describe, expect, mock, test } from "bun:test";
import type { Context } from "grammy";
import { createNormalizer } from "./normalize.js";

const TEST_TOKEN = "test-bot-token";
const normalize = createNormalizer(TEST_TOKEN);

// ---------------------------------------------------------------------------
// Context stub helpers
// ---------------------------------------------------------------------------

const CHAT_ID = 12345;
const USER_ID = 67890;

/** Creates a minimal Context stub with the given overrides. */
function makeCtx(
  overrides: Partial<{
    chatId: number;
    userId: number;
    message: Partial<Context["message"]>;
    callbackQuery: Partial<Context["callbackQuery"]>;
    answerCallbackQuery: () => Promise<void>;
    /** Pass null to simulate file_path being absent in the API response. */
    getFilePath: string | null;
  }>,
): Context {
  const chatId = overrides.chatId ?? CHAT_ID;
  const userId = overrides.userId ?? USER_ID;

  // Use explicit null to distinguish "not provided" (default path) from "absent" (no file_path)
  const filePath =
    overrides.getFilePath === null ? undefined : (overrides.getFilePath ?? "photos/mock_file.jpg");

  const mockGetFile = mock(async () => ({
    file_id: "mock_file_id",
    file_unique_id: "mock_unique_id",
    file_size: 1024,
    ...(filePath !== undefined && { file_path: filePath }),
  }));

  const mockAnswerCbq = overrides.answerCallbackQuery ?? mock(async () => {});

  return {
    chat: { id: chatId },
    from: { id: userId },
    message: overrides.message as Context["message"],
    callbackQuery: overrides.callbackQuery as Context["callbackQuery"],
    answerCallbackQuery: mockAnswerCbq,
    getFile: mockGetFile,
    api: {
      token: TEST_TOKEN,
      getFile: mockGetFile,
    },
  } as unknown as Context;
}

/** Convenience: context with a text message. */
function textCtx(content: string): Context {
  return makeCtx({ message: { text: content } });
}

// ---------------------------------------------------------------------------
// Text messages
// ---------------------------------------------------------------------------

describe("normalize — text messages", () => {
  test("returns TextBlock for plain text message", async () => {
    const msg = await normalize(textCtx("hello world"));
    expect(msg).not.toBeNull();
    expect(msg?.content).toEqual([{ kind: "text", text: "hello world" }]);
  });

  test("sets senderId from from.id", async () => {
    const msg = await normalize(textCtx("hi"));
    expect(msg?.senderId).toBe(String(USER_ID));
  });

  test("sets threadId from chat.id", async () => {
    const msg = await normalize(textCtx("hi"));
    expect(msg?.threadId).toBe(String(CHAT_ID));
  });

  test("sets timestamp as number", async () => {
    const before = Date.now();
    const msg = await normalize(textCtx("hi"));
    const after = Date.now();
    expect(msg?.timestamp).toBeGreaterThanOrEqual(before);
    expect(msg?.timestamp).toBeLessThanOrEqual(after);
  });
});

// ---------------------------------------------------------------------------
// Photo messages
// ---------------------------------------------------------------------------

describe("normalize — photo messages", () => {
  test("returns ImageBlock with resolved CDN URL", async () => {
    const ctx = makeCtx({
      message: {
        photo: [
          { file_id: "small", file_unique_id: "su1", width: 100, height: 100, file_size: 100 },
          { file_id: "large", file_unique_id: "su2", width: 800, height: 600, file_size: 5000 },
        ],
      },
      getFilePath: "photos/large.jpg",
    });
    const msg = await normalize(ctx);
    expect(msg).not.toBeNull();
    expect(msg?.content[0]).toMatchObject({
      kind: "image",
      url: `https://api.telegram.org/file/bot${TEST_TOKEN}/photos/large.jpg`,
    });
  });

  test("falls back to tg:// URL when file_path unavailable", async () => {
    const ctx = makeCtx({
      message: {
        photo: [{ file_id: "file123", file_unique_id: "u1", width: 100, height: 100 }],
      },
      getFilePath: null, // null = simulate absent file_path in API response
    });
    const msg = await normalize(ctx);
    expect(msg?.content[0]).toMatchObject({ kind: "image", url: "tg://file/file123" });
  });

  test("includes caption as alt text", async () => {
    const ctx = makeCtx({
      message: {
        photo: [{ file_id: "f1", file_unique_id: "u1", width: 100, height: 100 }],
        caption: "My photo",
      },
    });
    const msg = await normalize(ctx);
    expect(msg?.content[0]).toMatchObject({ kind: "image", alt: "My photo" });
  });
});

// ---------------------------------------------------------------------------
// Document messages
// ---------------------------------------------------------------------------

describe("normalize — document messages", () => {
  test("returns FileBlock with CDN URL", async () => {
    const ctx = makeCtx({
      message: {
        document: {
          file_id: "doc_id",
          file_unique_id: "du1",
          mime_type: "application/pdf",
          file_name: "report.pdf",
        },
      },
      getFilePath: "documents/report.pdf",
    });
    const msg = await normalize(ctx);
    expect(msg?.content[0]).toMatchObject({
      kind: "file",
      url: `https://api.telegram.org/file/bot${TEST_TOKEN}/documents/report.pdf`,
      mimeType: "application/pdf",
      name: "report.pdf",
    });
  });

  test("uses application/octet-stream when mime_type absent", async () => {
    const ctx = makeCtx({
      message: { document: { file_id: "d1", file_unique_id: "u1" } },
    });
    const msg = await normalize(ctx);
    expect(msg?.content[0]).toMatchObject({ kind: "file", mimeType: "application/octet-stream" });
  });
});

// ---------------------------------------------------------------------------
// Audio / voice / video messages
// ---------------------------------------------------------------------------

describe("normalize — audio messages", () => {
  test("returns FileBlock for audio", async () => {
    const ctx = makeCtx({
      message: {
        audio: { file_id: "a1", file_unique_id: "au1", duration: 30, mime_type: "audio/mpeg" },
      },
    });
    const msg = await normalize(ctx);
    expect(msg?.content[0]).toMatchObject({ kind: "file", mimeType: "audio/mpeg" });
  });

  test("returns FileBlock for voice note", async () => {
    const ctx = makeCtx({
      message: {
        voice: { file_id: "v1", file_unique_id: "vu1", duration: 5, mime_type: "audio/ogg" },
      },
    });
    const msg = await normalize(ctx);
    expect(msg?.content[0]).toMatchObject({ kind: "file", mimeType: "audio/ogg" });
  });

  test("returns FileBlock for video", async () => {
    const ctx = makeCtx({
      message: {
        video: {
          file_id: "vid1",
          file_unique_id: "vu1",
          width: 1920,
          height: 1080,
          duration: 60,
          mime_type: "video/mp4",
        },
      },
    });
    const msg = await normalize(ctx);
    expect(msg?.content[0]).toMatchObject({ kind: "file", mimeType: "video/mp4" });
  });
});

// ---------------------------------------------------------------------------
// Sticker
// ---------------------------------------------------------------------------

describe("normalize — sticker", () => {
  test("returns CustomBlock with telegram:sticker type", async () => {
    const ctx = makeCtx({
      message: {
        sticker: {
          file_id: "stk1",
          file_unique_id: "su1",
          type: "regular",
          width: 512,
          height: 512,
          is_animated: false,
          is_video: false,
          emoji: "😀",
        },
      },
    });
    const msg = await normalize(ctx);
    expect(msg?.content[0]).toMatchObject({
      kind: "custom",
      type: "telegram:sticker",
      data: { fileId: "stk1", emoji: "😀", isAnimated: false },
    });
  });
});

// ---------------------------------------------------------------------------
// Callback query (button press)
// ---------------------------------------------------------------------------

describe("normalize — callback_query", () => {
  test("calls answerCallbackQuery", async () => {
    const answerFn = mock(async () => {});
    const ctx = makeCtx({
      callbackQuery: { data: "my_action" },
      answerCallbackQuery: answerFn,
    });
    await normalize(ctx);
    expect(answerFn).toHaveBeenCalledTimes(1);
  });

  test("returns ButtonBlock with action only", async () => {
    const ctx = makeCtx({ callbackQuery: { data: "do_thing" } });
    const msg = await normalize(ctx);
    expect(msg?.content[0]).toMatchObject({
      kind: "button",
      label: "do_thing",
      action: "do_thing",
    });
  });

  test("parses action:JSON payload", async () => {
    const ctx = makeCtx({ callbackQuery: { data: 'confirm:{"id":42}' } });
    const msg = await normalize(ctx);
    expect(msg?.content[0]).toMatchObject({
      kind: "button",
      action: "confirm",
      payload: { id: 42 },
    });
  });

  test("treats non-JSON payload as raw string", async () => {
    const ctx = makeCtx({ callbackQuery: { data: "action:raw-string" } });
    const msg = await normalize(ctx);
    expect(msg?.content[0]).toMatchObject({
      kind: "button",
      action: "action",
      payload: "raw-string",
    });
  });

  test("still returns InboundMessage when answerCallbackQuery rejects", async () => {
    const answerFn = mock(async () => {
      throw new Error("Telegram error");
    });
    const ctx = makeCtx({
      callbackQuery: { data: "act" },
      answerCallbackQuery: answerFn,
    });
    const msg = await normalize(ctx);
    // Must not throw — error is swallowed
    expect(msg).not.toBeNull();
    expect(msg?.content[0]).toMatchObject({ kind: "button", action: "act" });
  });
});

// ---------------------------------------------------------------------------
// Forum topic routing (message_thread_id)
// ---------------------------------------------------------------------------

describe("normalize — forum topic routing", () => {
  test("encodes message_thread_id into threadId as chatId:threadId", async () => {
    const ctx = makeCtx({ message: { text: "forum msg", message_thread_id: 42 } });
    const msg = await normalize(ctx);
    expect(msg?.threadId).toBe(`${CHAT_ID}:42`);
  });

  test("uses plain chatId when message_thread_id is absent (regression)", async () => {
    const msg = await normalize(textCtx("regular msg"));
    expect(msg?.threadId).toBe(String(CHAT_ID));
  });

  test("encodes message_thread_id for callback queries from forum topics", async () => {
    // callbackQuery.message holds the parent message — ctx.message is undefined
    // for callback_query updates. This is the bug-fix regression test.
    const ctx = makeCtx({
      callbackQuery: {
        data: "action",
        message: {
          chat: { id: CHAT_ID, type: "supergroup", title: "Test Forum" },
          message_id: 1,
          date: 0,
          message_thread_id: 42,
        },
      },
    });
    const msg = await normalize(ctx);
    expect(msg?.threadId).toBe(`${CHAT_ID}:42`);
  });

  test("uses plain chatId for callback queries without message_thread_id", async () => {
    const ctx = makeCtx({ callbackQuery: { data: "action" } });
    const msg = await normalize(ctx);
    expect(msg?.threadId).toBe(String(CHAT_ID));
  });
});

// ---------------------------------------------------------------------------
// Null-return system events
// ---------------------------------------------------------------------------

describe("normalize — system events return null", () => {
  test("returns null when ctx.from is undefined", async () => {
    const ctx = { chat: { id: CHAT_ID }, from: undefined } as unknown as Context;
    expect(await normalize(ctx)).toBeNull();
  });

  test("returns null when ctx.chat is undefined", async () => {
    const ctx = { chat: undefined, from: { id: USER_ID } } as unknown as Context;
    expect(await normalize(ctx)).toBeNull();
  });

  test("returns null for edited_message (ctx.message undefined, no callbackQuery)", async () => {
    const ctx = makeCtx({ message: undefined });
    expect(await normalize(ctx)).toBeNull();
  });

  test("returns null for unknown message types (location, contact, poll, etc.)", async () => {
    const ctx = makeCtx({ message: { location: { latitude: 0, longitude: 0 } } });
    expect(await normalize(ctx)).toBeNull();
  });
});
