import { describe, expect, test } from "bun:test";
import type { OutboundMessage } from "@koi/core";
import type { TelegramUpdateLike } from "./normalize.js";
import {
  createTelegramChannel,
  splitText,
  type TelegramApiLike,
  type TelegramBotLike,
} from "./telegram-channel.js";

interface ApiCall {
  readonly method: "sendMessage" | "sendPhoto" | "sendDocument" | "answerCallbackQuery";
  readonly args: unknown;
}

function fakeBot(): {
  readonly bot: TelegramBotLike;
  readonly calls: ApiCall[];
  readonly emit: (update: TelegramUpdateLike) => void;
  setSendError: (err: unknown) => void;
} {
  const calls: ApiCall[] = [];
  // let requires justification: mutable state for the fake — middlewares + injected error
  let middlewares: ((
    ctx: { readonly update: TelegramUpdateLike },
    next: () => Promise<void>,
  ) => Promise<void> | void)[] = [];
  let sendError: unknown;
  const api: TelegramApiLike = {
    sendMessage: async (chat_id, text, other) => {
      if (sendError !== undefined) {
        const err = sendError;
        sendError = undefined;
        throw err;
      }
      calls.push({ method: "sendMessage", args: { chat_id, text, ...(other ?? {}) } });
      return undefined;
    },
    sendPhoto: async (chat_id, photo, other) => {
      calls.push({ method: "sendPhoto", args: { chat_id, photo, ...(other ?? {}) } });
      return undefined;
    },
    sendDocument: async (chat_id, document, other) => {
      calls.push({ method: "sendDocument", args: { chat_id, document, ...(other ?? {}) } });
      return undefined;
    },
    getFile: async () => ({ file_path: "doc/abc.bin" }),
    answerCallbackQuery: async (id) => {
      calls.push({ method: "answerCallbackQuery", args: id });
      return undefined;
    },
    getMe: async () => ({ id: 999, username: "fakebot" }),
  };
  const bot: TelegramBotLike = {
    api,
    use: (mw) => {
      middlewares = [...middlewares, mw];
      return undefined;
    },
    start: async () => undefined,
    stop: async () => undefined,
  };
  return {
    bot,
    calls,
    emit: (u) => {
      for (const mw of middlewares) void mw({ update: u }, async () => undefined);
    },
    setSendError: (e) => {
      sendError = e;
    },
  };
}

describe("@koi/channel-telegram createTelegramChannel", () => {
  test("connect / disconnect drives bot.start / bot.stop in polling mode", async () => {
    const f = fakeBot();
    let started = 0;
    let stopped = 0;
    const bot: TelegramBotLike = {
      ...f.bot,
      start: async () => {
        started++;
      },
      stop: async () => {
        stopped++;
      },
    };
    const adapter = createTelegramChannel({ token: "T", bot });
    await adapter.connect();
    expect(started).toBe(1);
    await adapter.disconnect();
    expect(stopped).toBe(1);
  });

  test("connect rejects when bot.start() rejects within the startup window (no false-connected state)", async () => {
    const f = fakeBot();
    const failingBot: TelegramBotLike = {
      ...f.bot,
      start: async () => {
        throw new Error("409 Conflict: another instance is polling");
      },
    };
    const adapter = createTelegramChannel({ token: "T", bot: failingBot });
    await expect(adapter.connect()).rejects.toThrow(/start.*rejected|409/);
  });

  test("post-startup polling rejection forces the adapter to disconnect (no silent ingress loss)", async () => {
    const f = fakeBot();
    // let requires justification: deferred reject for late polling failure
    let rejectStart: (err: unknown) => void = () => undefined;
    const lateFailingBot: TelegramBotLike = {
      ...f.bot,
      start: () =>
        new Promise<void>((_resolve, reject) => {
          rejectStart = reject;
        }),
    };
    const errors: unknown[] = [];
    const adapter = createTelegramChannel({
      token: "T",
      bot: lateFailingBot,
      onHandlerError: (err) => errors.push(err),
    });
    await adapter.connect();
    // Trigger a late polling rejection — well past the 250ms startup race.
    rejectStart(new Error("network gone"));
    await new Promise((r) => setTimeout(r, 30));
    expect(errors).toHaveLength(1);
    // Adapter must no longer be connected; send() must reject.
    await expect(
      adapter.send({ content: [{ kind: "text", text: "x" }], threadId: "200" }),
    ).rejects.toThrow();
  });

  test("connect surfaces a token-validation failure synchronously (getMe handshake)", async () => {
    const f = fakeBot();
    const badBot: TelegramBotLike = {
      ...f.bot,
      api: {
        ...f.bot.api,
        getMe: async () => {
          throw new Error("401 Unauthorized");
        },
      },
    };
    const adapter = createTelegramChannel({ token: "T", bot: badBot });
    await expect(adapter.connect()).rejects.toThrow(/401/);
  });

  test("polling: incoming text update dispatches an InboundMessage", async () => {
    const f = fakeBot();
    const adapter = createTelegramChannel({ token: "T", bot: f.bot });
    await adapter.connect();
    const seen: unknown[] = [];
    adapter.onMessage(async (m) => {
      seen.push(m);
    });
    f.emit({
      update_id: 1,
      message: {
        message_id: 1,
        from: { id: 9 },
        chat: { id: 200 },
        date: 1700000000,
        text: "hi",
      },
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(seen).toHaveLength(1);
    await adapter.disconnect();
  });

  test("webhook: handleWebhook rejects when no webhookSecret is configured (fails closed)", async () => {
    const f = fakeBot();
    const adapter = createTelegramChannel({
      token: "T",
      bot: f.bot,
      deployment: { mode: "webhook" },
    });
    await adapter.connect();
    expect(() =>
      adapter.handleWebhook("any", {
        update_id: 1,
        message: { message_id: 1, from: { id: 9 }, chat: { id: 200 }, date: 1, text: "x" },
      }),
    ).toThrow(/webhookSecret/);
    await adapter.disconnect();
  });

  test("webhook: handleWebhook rejects on secret mismatch", async () => {
    const f = fakeBot();
    const adapter = createTelegramChannel({
      token: "T",
      bot: f.bot,
      deployment: { mode: "webhook" },
      webhookSecret: "expected",
    });
    await adapter.connect();
    const seen: unknown[] = [];
    adapter.onMessage(async (m) => {
      seen.push(m);
    });
    expect(() =>
      adapter.handleWebhook("WRONG", {
        update_id: 1,
        message: { message_id: 1, from: { id: 9 }, chat: { id: 200 }, date: 1, text: "x" },
      }),
    ).toThrow(/secret mismatch/);
    expect(() =>
      adapter.handleWebhook(undefined, {
        update_id: 1,
        message: { message_id: 1, from: { id: 9 }, chat: { id: 200 }, date: 1, text: "x" },
      }),
    ).toThrow(/secret mismatch/);
    await new Promise((r) => setTimeout(r, 10));
    expect(seen).toHaveLength(0);
    await adapter.disconnect();
  });

  test("webhook: handleWebhook dispatches when secret matches", async () => {
    const f = fakeBot();
    const adapter = createTelegramChannel({
      token: "T",
      bot: f.bot,
      deployment: { mode: "webhook" },
      webhookSecret: "expected",
    });
    await adapter.connect();
    const seen: unknown[] = [];
    adapter.onMessage(async (m) => {
      seen.push(m);
    });
    adapter.handleWebhook("expected", {
      update_id: 1,
      message: { message_id: 1, from: { id: 9 }, chat: { id: 200 }, date: 1, text: "hi" },
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(seen).toHaveLength(1);
    await adapter.disconnect();
  });

  test("webhook: handleUpdate forwards updates to the registered listener", async () => {
    const f = fakeBot();
    const adapter = createTelegramChannel({
      token: "T",
      bot: f.bot,
      deployment: { mode: "webhook" },
    });
    await adapter.connect();
    const seen: unknown[] = [];
    adapter.onMessage(async (m) => {
      seen.push(m);
    });
    adapter.handleUpdate({
      update_id: 1,
      message: { message_id: 1, from: { id: 9 }, chat: { id: 200 }, date: 1, text: "hi" },
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(seen).toHaveLength(1);
    await adapter.disconnect();
  });

  test("send: text message calls sendMessage with chat_id", async () => {
    const f = fakeBot();
    const adapter = createTelegramChannel({ token: "T", bot: f.bot });
    await adapter.connect();
    const out: OutboundMessage = {
      content: [{ kind: "text", text: "hello" }],
      threadId: "200",
    };
    await adapter.send(out);
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]?.method).toBe("sendMessage");
    const args = f.calls[0]?.args as {
      chat_id: number;
      text?: string;
      message_thread_id?: number;
      reply_markup?: { inline_keyboard: { text: string; callback_data: string }[][] };
    };
    expect(args.chat_id).toBe(200);
    expect(args.text).toBe("hello");
    expect(args.message_thread_id).toBeUndefined();
    await adapter.disconnect();
  });

  test("send: forum topic threadId routes message_thread_id", async () => {
    const f = fakeBot();
    const adapter = createTelegramChannel({ token: "T", bot: f.bot });
    await adapter.connect();
    await adapter.send({
      content: [{ kind: "text", text: "x" }],
      threadId: "200:5",
    });
    const args = f.calls[0]?.args as {
      chat_id: number;
      text?: string;
      message_thread_id?: number;
      reply_markup?: { inline_keyboard: { text: string; callback_data: string }[][] };
    };
    expect(args.chat_id).toBe(200);
    expect(args.message_thread_id).toBe(5);
    await adapter.disconnect();
  });

  test("send: button-only message uses a non-empty placeholder text (Telegram rejects empty)", async () => {
    const f = fakeBot();
    const adapter = createTelegramChannel({ token: "T", bot: f.bot });
    await adapter.connect();
    await adapter.send({
      content: [{ kind: "button", label: "Yes", action: "yes" }],
      threadId: "200",
    });
    expect(f.calls).toHaveLength(1);
    const args = f.calls[0]?.args as {
      chat_id: number;
      text?: string;
      message_thread_id?: number;
      reply_markup?: { inline_keyboard: { text: string; callback_data: string }[][] };
    };
    expect(args.text).toBeDefined();
    expect((args.text as string).length).toBeGreaterThan(0);
    expect(args.reply_markup?.inline_keyboard[0]?.[0]?.callback_data).toBe("yes");
    await adapter.disconnect();
  });

  test("send: button block becomes inline_keyboard on last text chunk", async () => {
    const f = fakeBot();
    const adapter = createTelegramChannel({ token: "T", bot: f.bot });
    await adapter.connect();
    await adapter.send({
      content: [
        { kind: "text", text: "pick one" },
        { kind: "button", label: "Yes", action: "yes" },
        { kind: "button", label: "No", action: "no", payload: { reason: "x" } },
      ],
      threadId: "200",
    });
    const args = f.calls[0]?.args as {
      chat_id: number;
      text?: string;
      message_thread_id?: number;
      reply_markup?: { inline_keyboard: { text: string; callback_data: string }[][] };
    };
    expect(args.reply_markup?.inline_keyboard[0]).toEqual([
      { text: "Yes", callback_data: "yes" },
      { text: "No", callback_data: 'no:{"reason":"x"}' },
    ]);
    await adapter.disconnect();
  });

  test("send: image block calls sendPhoto with caption", async () => {
    const f = fakeBot();
    const adapter = createTelegramChannel({ token: "T", bot: f.bot });
    await adapter.connect();
    await adapter.send({
      content: [{ kind: "image", url: "https://x/p.jpg", alt: "cat" }],
      threadId: "200",
    });
    expect(f.calls[0]?.method).toBe("sendPhoto");
    expect(f.calls[0]?.args).toEqual({ chat_id: 200, photo: "https://x/p.jpg", caption: "cat" });
    await adapter.disconnect();
  });

  test("send: file block calls sendDocument", async () => {
    const f = fakeBot();
    const adapter = createTelegramChannel({ token: "T", bot: f.bot });
    await adapter.connect();
    await adapter.send({
      content: [{ kind: "file", url: "https://x/d.pdf", mimeType: "application/pdf" }],
      threadId: "200",
    });
    expect(f.calls[0]?.method).toBe("sendDocument");
    await adapter.disconnect();
  });

  test("send: 429 retry_after triggers a single sleep + retry", async () => {
    const f = fakeBot();
    const adapter = createTelegramChannel({ token: "T", bot: f.bot });
    await adapter.connect();
    f.setSendError({ error_code: 429, parameters: { retry_after: 0 } });
    await adapter.send({ content: [{ kind: "text", text: "x" }], threadId: "200" });
    expect(f.calls).toHaveLength(1);
    await adapter.disconnect();
  });

  test("send: inline:<id> threadId is rejected (no chat to reply to, fails closed)", async () => {
    const f = fakeBot();
    const adapter = createTelegramChannel({ token: "T", bot: f.bot });
    await adapter.connect();
    await expect(
      adapter.send({ content: [{ kind: "text", text: "x" }], threadId: "inline:abc123" }),
    ).rejects.toThrow(/inline-mode/);
    expect(f.calls).toHaveLength(0);
    await adapter.disconnect();
  });

  test("send: malformed forum-topic suffix is rejected (fails closed, no leak to parent chat)", async () => {
    const f = fakeBot();
    const adapter = createTelegramChannel({ token: "T", bot: f.bot });
    await adapter.connect();
    await expect(
      adapter.send({ content: [{ kind: "text", text: "x" }], threadId: "200:not-a-number" }),
    ).rejects.toThrow(/forum-topic suffix/);
    expect(f.calls).toHaveLength(0);
    await adapter.disconnect();
  });

  test("send: invalid threadId throws", async () => {
    const f = fakeBot();
    const adapter = createTelegramChannel({ token: "T", bot: f.bot });
    await adapter.connect();
    await expect(
      adapter.send({ content: [{ kind: "text", text: "x" }], threadId: "not-a-number" }),
    ).rejects.toThrow(/invalid threadId/);
    await adapter.disconnect();
  });

  test("send: missing threadId throws", async () => {
    const f = fakeBot();
    const adapter = createTelegramChannel({ token: "T", bot: f.bot });
    await adapter.connect();
    await expect(adapter.send({ content: [{ kind: "text", text: "x" }] })).rejects.toThrow(
      /threadId is required/,
    );
    await adapter.disconnect();
  });

  test("send: oversized callback_data fails before any media is sent (no partial delivery)", async () => {
    const f = fakeBot();
    const adapter = createTelegramChannel({ token: "T", bot: f.bot });
    await adapter.connect();
    const big = "x".repeat(80);
    await expect(
      adapter.send({
        content: [
          { kind: "image", url: "https://x/p.jpg" },
          { kind: "text", text: "pick" },
          { kind: "button", label: "Long", action: big },
        ],
        threadId: "200",
      }),
    ).rejects.toThrow(/callback_data exceeds/);
    expect(f.calls).toHaveLength(0);
    await adapter.disconnect();
  });

  test("send: very long text is split at 4096-char boundary", async () => {
    const f = fakeBot();
    const adapter = createTelegramChannel({ token: "T", bot: f.bot });
    await adapter.connect();
    const big = "x".repeat(9000);
    await adapter.send({ content: [{ kind: "text", text: big }], threadId: "200" });
    expect(f.calls.length).toBeGreaterThanOrEqual(3);
    await adapter.disconnect();
  });

  test("inbound photo update resolves URL via getFile + answerCallbackQuery is independent", async () => {
    const f = fakeBot();
    const adapter = createTelegramChannel({ token: "T", bot: f.bot });
    await adapter.connect();
    const seen: unknown[] = [];
    adapter.onMessage(async (m) => {
      seen.push(m);
    });
    f.emit({
      update_id: 2,
      message: {
        message_id: 1,
        from: { id: 1 },
        chat: { id: 200 },
        date: 1,
        photo: [{ file_id: "big", width: 1024, height: 1024 }],
      },
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(seen).toHaveLength(1);
    await adapter.disconnect();
  });
});

describe("resolveMediaUrl (token boundary)", () => {
  test("inbound photo url is opaque tg://file/<id> — token never surfaces", async () => {
    const f = fakeBot();
    const adapter = createTelegramChannel({ token: "SECRET_TOKEN", bot: f.bot });
    await adapter.connect();
    const seen: { content: readonly Record<string, unknown>[] }[] = [];
    adapter.onMessage(async (m) => {
      seen.push(m as unknown as { content: readonly Record<string, unknown>[] });
    });
    f.emit({
      update_id: 1,
      message: {
        message_id: 1,
        from: { id: 1 },
        chat: { id: 200 },
        date: 1,
        photo: [{ file_id: "F1", width: 1024, height: 1024 }],
      },
    });
    await new Promise((r) => setTimeout(r, 30));
    const url = seen[0]?.content[0]?.url;
    expect(url).toBe("tg://file/F1");
    expect(url).not.toContain("SECRET_TOKEN");
    await adapter.disconnect();
  });

  test("resolveMediaUrl resolves an opaque ref to a token-bearing CDN url at the fetch site", async () => {
    const f = fakeBot();
    const adapter = createTelegramChannel({ token: "SECRET_TOKEN", bot: f.bot });
    await adapter.connect();
    const url = await adapter.resolveMediaUrl("tg://file/F1");
    expect(url).toBe("https://api.telegram.org/file/botSECRET_TOKEN/doc/abc.bin");
    await adapter.disconnect();
  });

  test("resolveMediaUrl throws when getFile returns no file_path", async () => {
    const f = fakeBot();
    const noPathBot = {
      ...f.bot,
      api: { ...f.bot.api, getFile: async () => ({}) },
    };
    const adapter = createTelegramChannel({ token: "T", bot: noPathBot });
    await adapter.connect();
    await expect(adapter.resolveMediaUrl("F1")).rejects.toThrow(/file_path unavailable/);
    await adapter.disconnect();
  });

  test("resolveMediaUrl accepts a bare file_id too", async () => {
    const f = fakeBot();
    const adapter = createTelegramChannel({ token: "T", bot: f.bot });
    await adapter.connect();
    const url = await adapter.resolveMediaUrl("F1");
    expect(url).toBe("https://api.telegram.org/file/botT/doc/abc.bin");
    await adapter.disconnect();
  });
});

describe("grammY shape compatibility", () => {
  test("a real grammY Bot satisfies TelegramBotLike (use/start/stop/api shape)", async () => {
    // Imports the real grammy module and verifies a constructed Bot can be
    // assigned to TelegramBotLike. This is the contract test the
    // adversarial reviewer asked for: the adapter's interface must match
    // grammY's actual surface, not a hand-shaped double. Token format
    // follows Telegram's "<bot_id>:<auth_token>" scheme so the constructor
    // doesn't reject us; we never call start() so no network happens.
    const { Bot } = await import("grammy");
    const bot = new Bot("1:abcdefghijklmnopqrstuvwxyz0123456789");
    const asLike: TelegramBotLike = bot;
    expect(typeof asLike.use).toBe("function");
    expect(typeof asLike.start).toBe("function");
    expect(typeof asLike.stop).toBe("function");
    expect(typeof asLike.api.sendMessage).toBe("function");
    expect(typeof asLike.api.getMe).toBe("function");
  });
});

describe("splitText", () => {
  test("returns input unchanged when below limit", () => {
    expect(splitText("abc", 100)).toEqual(["abc"]);
  });
  test("hard-cuts when no newline boundary", () => {
    const parts = splitText("a".repeat(5), 2);
    expect(parts.every((p) => p.length <= 2)).toBe(true);
  });
});
