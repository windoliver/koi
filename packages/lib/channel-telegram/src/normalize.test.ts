import { describe, expect, test } from "bun:test";
import {
  createNormalizer,
  type TelegramCallbackQueryLike,
  type TelegramMessageLike,
  type TelegramNormalizerDeps,
  type TelegramUpdateLike,
} from "./normalize.js";

function deps(over: Partial<TelegramNormalizerDeps> = {}): TelegramNormalizerDeps {
  return {
    getFileUrl: async (id) => `https://cdn/${id}`,
    answerCallbackQuery: async () => undefined,
    ...over,
  };
}

function tgMessage(over: Partial<TelegramMessageLike> = {}): TelegramMessageLike {
  return {
    message_id: 1,
    from: { id: 100 },
    chat: { id: 200 },
    date: 1700000000,
    ...over,
  };
}

function tgUpdate(over: Partial<TelegramUpdateLike> = {}): TelegramUpdateLike {
  return { update_id: 1, ...over };
}

describe("@koi/channel-telegram normalize", () => {
  test("text message normalized with chatId as threadId", async () => {
    const n = createNormalizer(deps());
    const out = await n(tgUpdate({ message: tgMessage({ text: "hello" }) }));
    expect(out?.threadId).toBe("200");
    expect(out?.senderId).toBe("100");
    expect(out?.content[0]).toEqual({ kind: "text", text: "hello" });
    expect(out?.timestamp).toBe(1700000000 * 1000);
  });

  test("forum topic uses chatId:threadId convention", async () => {
    const n = createNormalizer(deps());
    const out = await n(tgUpdate({ message: tgMessage({ text: "hi", message_thread_id: 9 }) }));
    expect(out?.threadId).toBe("200:9");
  });

  test("returns null when message has no from (channel post)", async () => {
    const n = createNormalizer(deps());
    const noFromMsg: TelegramMessageLike = {
      message_id: 1,
      chat: { id: 200 },
      date: 1700000000,
      text: "anon",
    };
    const out = await n(tgUpdate({ message: noFromMsg }));
    expect(out).toBeNull();
  });

  test("photo: uses highest resolution variant via getFileUrl", async () => {
    let calls = 0;
    let lastId = "";
    const n = createNormalizer(
      deps({
        getFileUrl: async (id) => {
          calls++;
          lastId = id;
          return `https://cdn/${id}`;
        },
      }),
    );
    const out = await n(
      tgUpdate({
        message: tgMessage({
          photo: [
            { file_id: "small", width: 100, height: 100 },
            { file_id: "big", width: 1024, height: 1024 },
          ],
          caption: "cat",
        }),
      }),
    );
    expect(calls).toBe(1);
    expect(lastId).toBe("big");
    expect(out?.content[0]).toEqual({ kind: "image", url: "https://cdn/big", alt: "cat" });
  });

  test("document: file block carries mimeType and name", async () => {
    const n = createNormalizer(deps());
    const out = await n(
      tgUpdate({
        message: tgMessage({
          document: { file_id: "f1", file_name: "report.pdf", mime_type: "application/pdf" },
        }),
      }),
    );
    expect(out?.content[0]).toEqual({
      kind: "file",
      url: "https://cdn/f1",
      mimeType: "application/pdf",
      name: "report.pdf",
    });
  });

  test("callback_query: parses action + payload, calls answerCallbackQuery", async () => {
    let acked: string | undefined;
    const n = createNormalizer(
      deps({
        answerCallbackQuery: async (id) => {
          acked = id;
        },
      }),
    );
    const cq: TelegramCallbackQueryLike = {
      id: "cb123",
      from: { id: 42 },
      data: 'confirm:{"orderId":7}',
      message: tgMessage({ chat: { id: 200 } }),
    };
    const out = await n(tgUpdate({ callback_query: cq }));
    expect(acked).toBe("cb123");
    expect(out?.threadId).toBe("200");
    expect(out?.content[0]).toEqual({
      kind: "button",
      label: "confirm",
      action: "confirm",
      payload: { orderId: 7 },
    });
  });

  test("callback_query: ack failure is caught and reported via onAckError", async () => {
    let captured: unknown;
    const n = createNormalizer(
      deps({
        answerCallbackQuery: async () => {
          throw new Error("boom");
        },
        onAckError: (err) => {
          captured = err;
        },
      }),
    );
    const cq: TelegramCallbackQueryLike = {
      id: "cb",
      from: { id: 1 },
      data: "x",
      message: tgMessage({ chat: { id: 2 } }),
    };
    const out = await n(tgUpdate({ callback_query: cq }));
    expect(captured).toBeInstanceOf(Error);
    expect(out).not.toBeNull();
  });

  test("callback_query without message emits non-repliable inline:cq:<id> (fails closed, no DM leak)", async () => {
    const n = createNormalizer(deps());
    const cq: TelegramCallbackQueryLike = { id: "cb", from: { id: 7 }, data: "ping" };
    const out = await n(tgUpdate({ callback_query: cq }));
    expect(out?.threadId).toBe("inline:cq:cb");
  });

  test("inline-mode callback_query produces a non-repliable inline:<id> threadId", async () => {
    const n = createNormalizer(deps());
    const cq: TelegramCallbackQueryLike = {
      id: "cb",
      from: { id: 99 },
      data: "x",
      inline_message_id: "INLINE_42",
    };
    const out = await n(tgUpdate({ callback_query: cq }));
    expect(out?.threadId).toBe("inline:INLINE_42");
  });

  test("update with neither message nor callback_query returns null", async () => {
    const n = createNormalizer(deps());
    const out = await n(tgUpdate());
    expect(out).toBeNull();
  });
});
