/**
 * Unit tests for platform-send.ts — OutboundMessage → Telegram API calls.
 *
 * Uses spyOn(bot.api, ...) to verify API calls without hitting Telegram servers.
 * A real Bot is constructed with a dummy token (grammY lazy-inits the API).
 */

import { beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { OutboundMessage } from "@koi/core";
import { Bot, GrammyError } from "grammy";
import { telegramSend } from "./platform-send.js";

// Dummy token — grammY validates format but doesn't make API calls until start()
const DUMMY_TOKEN = "123456789:AABBCCDDEEFFaabbccddeeff-1234567890";
const CHAT_ID = "42";

function makeBot(): Bot {
  return new Bot(DUMMY_TOKEN);
}

function msg(overrides: Partial<OutboundMessage>): OutboundMessage {
  return {
    content: overrides.content ?? [{ kind: "text", text: "hello" }],
    threadId: overrides.threadId ?? CHAT_ID,
    ...(overrides.metadata !== undefined && { metadata: overrides.metadata }),
  };
}

// ---------------------------------------------------------------------------
// Missing threadId
// ---------------------------------------------------------------------------

describe("telegramSend — missing threadId", () => {
  test("throws when threadId is undefined", async () => {
    const bot = makeBot();
    await expect(telegramSend(bot, { content: [{ kind: "text", text: "hi" }] })).rejects.toThrow(
      "threadId",
    );
  });
});

// ---------------------------------------------------------------------------
// Text blocks
// ---------------------------------------------------------------------------

describe("telegramSend — text blocks", () => {
  let bot: Bot;
  let sendMessage: ReturnType<typeof spyOn>;

  beforeEach(() => {
    bot = makeBot();
    sendMessage = spyOn(bot.api, "sendMessage").mockResolvedValue({} as never);
  });

  test("sends a single sendMessage for one text block", async () => {
    await telegramSend(bot, msg({ content: [{ kind: "text", text: "hello" }] }));
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(CHAT_ID, "hello");
  });

  test("merges two adjacent text blocks into one sendMessage", async () => {
    await telegramSend(
      bot,
      msg({
        content: [
          { kind: "text", text: "line 1" },
          { kind: "text", text: "line 2" },
        ],
      }),
    );
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(CHAT_ID, "line 1\nline 2");
  });

  test("splits text over 4096 chars into multiple sendMessage calls", async () => {
    const longText = "a".repeat(5000);
    await telegramSend(bot, msg({ content: [{ kind: "text", text: longText }] }));
    expect(sendMessage).toHaveBeenCalledTimes(2);
    // First call should be 4096 chars max
    const firstCallText = (sendMessage.mock.calls[0] as unknown[])[1] as string;
    expect(firstCallText.length).toBeLessThanOrEqual(4096);
  });

  test("sends non-adjacent text blocks as separate sendMessage calls", async () => {
    // Also stub sendPhoto to avoid network call for the image block
    spyOn(bot.api, "sendPhoto").mockResolvedValue({} as never);
    await telegramSend(
      bot,
      msg({
        content: [
          { kind: "text", text: "before" },
          { kind: "image", url: "https://example.com/img.jpg" },
          { kind: "text", text: "after" },
        ],
      }),
    );
    expect(sendMessage).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// Image blocks
// ---------------------------------------------------------------------------

describe("telegramSend — image blocks", () => {
  test("calls sendPhoto with url and caption", async () => {
    const bot = makeBot();
    const sendPhoto = spyOn(bot.api, "sendPhoto").mockResolvedValue({} as never);
    await telegramSend(
      bot,
      msg({
        content: [{ kind: "image", url: "https://example.com/photo.jpg", alt: "A photo" }],
      }),
    );
    expect(sendPhoto).toHaveBeenCalledTimes(1);
    expect(sendPhoto).toHaveBeenCalledWith(CHAT_ID, "https://example.com/photo.jpg", {
      caption: "A photo",
    });
  });

  test("calls sendPhoto without caption when alt is absent", async () => {
    const bot = makeBot();
    const sendPhoto = spyOn(bot.api, "sendPhoto").mockResolvedValue({} as never);
    await telegramSend(
      bot,
      msg({
        content: [{ kind: "image", url: "https://example.com/photo.jpg" }],
      }),
    );
    expect(sendPhoto).toHaveBeenCalledWith(CHAT_ID, "https://example.com/photo.jpg", {});
  });
});

// ---------------------------------------------------------------------------
// File blocks
// ---------------------------------------------------------------------------

describe("telegramSend — file blocks", () => {
  test("calls sendDocument with url and caption", async () => {
    const bot = makeBot();
    const sendDocument = spyOn(bot.api, "sendDocument").mockResolvedValue({} as never);
    await telegramSend(
      bot,
      msg({
        content: [
          {
            kind: "file",
            url: "https://example.com/doc.pdf",
            mimeType: "application/pdf",
            name: "doc.pdf",
          },
        ],
      }),
    );
    expect(sendDocument).toHaveBeenCalledTimes(1);
    expect(sendDocument).toHaveBeenCalledWith(CHAT_ID, "https://example.com/doc.pdf", {
      caption: "doc.pdf",
    });
  });
});

// ---------------------------------------------------------------------------
// Button blocks
// ---------------------------------------------------------------------------

describe("telegramSend — button blocks", () => {
  test("calls sendMessage with inline keyboard for button block", async () => {
    const bot = makeBot();
    const sendMessage = spyOn(bot.api, "sendMessage").mockResolvedValue({} as never);
    await telegramSend(
      bot,
      msg({
        content: [{ kind: "button", label: "Click me", action: "do_thing" }],
      }),
    );
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const [, , opts] = sendMessage.mock.calls[0] as [string, string, { reply_markup?: unknown }];
    expect(opts?.reply_markup).toBeDefined();
  });

  test("encodes action-only callback_data when no payload", async () => {
    const bot = makeBot();
    const sendMessage = spyOn(bot.api, "sendMessage").mockResolvedValue({} as never);
    await telegramSend(
      bot,
      msg({
        content: [{ kind: "button", label: "OK", action: "confirm" }],
      }),
    );
    // Inline keyboard inline_keyboard[0][0].callback_data should be "confirm"
    const [, , opts] = sendMessage.mock.calls[0] as [
      string,
      string,
      { reply_markup?: { inline_keyboard?: unknown[][] } },
    ];
    const keyboard = opts?.reply_markup?.inline_keyboard;
    const firstButton = (keyboard?.[0]?.[0] ?? {}) as { callback_data?: string };
    expect(firstButton.callback_data).toBe("confirm");
  });

  test("encodes action:payload when payload fits in 64 bytes", async () => {
    const bot = makeBot();
    const sendMessage = spyOn(bot.api, "sendMessage").mockResolvedValue({} as never);
    await telegramSend(
      bot,
      msg({
        content: [{ kind: "button", label: "Pay", action: "pay", payload: { amount: 100 } }],
      }),
    );
    const [, , opts] = sendMessage.mock.calls[0] as [
      string,
      string,
      { reply_markup?: { inline_keyboard?: unknown[][] } },
    ];
    const firstButton = (opts?.reply_markup?.inline_keyboard?.[0]?.[0] ?? {}) as {
      callback_data?: string;
    };
    expect(firstButton.callback_data).toBe('pay:{"amount":100}');
  });

  test("drops payload and uses action only when combined exceeds 64 bytes", async () => {
    const bot = makeBot();
    const sendMessage = spyOn(bot.api, "sendMessage").mockResolvedValue({} as never);
    const bigPayload = { key: "x".repeat(60) };
    await telegramSend(
      bot,
      msg({
        content: [{ kind: "button", label: "Big", action: "act", payload: bigPayload }],
      }),
    );
    const [, , opts] = sendMessage.mock.calls[0] as [
      string,
      string,
      { reply_markup?: { inline_keyboard?: unknown[][] } },
    ];
    const firstButton = (opts?.reply_markup?.inline_keyboard?.[0]?.[0] ?? {}) as {
      callback_data?: string;
    };
    // Should fall back to action only since payload is too large
    expect(firstButton.callback_data).toBe("act");
    expect((firstButton.callback_data ?? "").length).toBeLessThanOrEqual(64);
  });
});

// ---------------------------------------------------------------------------
// Custom blocks
// ---------------------------------------------------------------------------

describe("telegramSend — custom blocks", () => {
  test("silently ignores custom blocks (no API call)", async () => {
    const bot = makeBot();
    const sendMessage = spyOn(bot.api, "sendMessage").mockResolvedValue({} as never);
    await telegramSend(
      bot,
      msg({
        content: [{ kind: "custom", type: "any", data: {} }],
      }),
    );
    expect(sendMessage).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Rate limit retry (429)
// ---------------------------------------------------------------------------

describe("telegramSend — 429 retry", () => {
  test("retries once after waiting retry_after seconds on 429", async () => {
    const bot = makeBot();
    // let requires justification: call count tracked across multiple spy calls
    let callCount = 0;
    spyOn(bot.api, "sendMessage").mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        const error = new GrammyError(
          "Too Many Requests",
          { ok: false, error_code: 429, description: "Too Many Requests: retry after 1" },
          "sendMessage",
          {},
        );
        // Attach retry_after to parameters
        (error as unknown as { parameters: { retry_after: number } }).parameters = {
          retry_after: 0,
        };
        throw error;
      }
      return {} as never;
    });

    await telegramSend(bot, msg({ content: [{ kind: "text", text: "hi" }] }));
    expect(callCount).toBe(2);
  });

  test("rethrows non-429 errors", async () => {
    const bot = makeBot();
    spyOn(bot.api, "sendMessage").mockRejectedValue(
      new GrammyError(
        "Bad Request",
        { ok: false, error_code: 400, description: "Bad Request" },
        "sendMessage",
        {},
      ),
    );
    await expect(
      telegramSend(bot, msg({ content: [{ kind: "text", text: "hi" }] })),
    ).rejects.toThrow();
  });
});
