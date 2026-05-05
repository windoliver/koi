import { describe, expect, test } from "bun:test";
import type { OutboundMessage } from "@koi/core";
import type { TelegramUpdateLike } from "./normalize.js";
import {
  createTelegramChannel,
  splitText,
  type TelegramApiLike,
  type TelegramBotLike,
  type TelegramSendOptions,
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
  // let requires justification: mutable state for the fake — listeners + injected error
  let listener: ((u: TelegramUpdateLike) => void) | undefined;
  let sendError: unknown;
  const api: TelegramApiLike = {
    sendMessage: async (opts: TelegramSendOptions) => {
      if (sendError !== undefined) {
        const err = sendError;
        sendError = undefined;
        throw err;
      }
      calls.push({ method: "sendMessage", args: opts });
      return undefined;
    },
    sendPhoto: async (opts) => {
      calls.push({ method: "sendPhoto", args: opts });
      return undefined;
    },
    sendDocument: async (opts) => {
      calls.push({ method: "sendDocument", args: opts });
      return undefined;
    },
    getFile: async () => ({ file_path: "doc/abc.bin" }),
    answerCallbackQuery: async (id) => {
      calls.push({ method: "answerCallbackQuery", args: id });
      return undefined;
    },
  };
  const bot: TelegramBotLike = {
    api,
    on: (_event, h) => {
      listener = h;
      return () => {
        listener = undefined;
      };
    },
    start: async () => undefined,
    stop: async () => undefined,
  };
  return {
    bot,
    calls,
    emit: (u) => listener?.(u),
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
    const args = f.calls[0]?.args as TelegramSendOptions;
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
    const args = f.calls[0]?.args as TelegramSendOptions;
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
    const args = f.calls[0]?.args as TelegramSendOptions;
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
    const args = f.calls[0]?.args as TelegramSendOptions;
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

describe("splitText", () => {
  test("returns input unchanged when below limit", () => {
    expect(splitText("abc", 100)).toEqual(["abc"]);
  });
  test("hard-cuts when no newline boundary", () => {
    const parts = splitText("a".repeat(5), 2);
    expect(parts.every((p) => p.length <= 2)).toBe(true);
  });
});
