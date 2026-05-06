/**
 * Integration tests: full webhook lifecycle + concurrent-claim race.
 *
 * Distinct from unit tests — these walk multiple operations in one
 * sequence to catch state leaks (claim store, handler subscriptions,
 * connection state) that single-call tests miss.
 */

import { describe, expect, test } from "bun:test";
import {
  createTelegramChannel,
  type TelegramApiLike,
  type TelegramBotLike,
} from "../telegram-channel.js";

interface ApiCall {
  readonly method: "sendMessage" | "sendPhoto" | "sendDocument";
  readonly args: Record<string, unknown>;
}

function fakeBot(): { readonly bot: TelegramBotLike; readonly calls: ApiCall[] } {
  const calls: ApiCall[] = [];
  const api: TelegramApiLike = {
    sendMessage: async (chat_id, text, other) => {
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
    getFile: async () => ({ file_path: "x" }),
    answerCallbackQuery: async () => undefined,
    getMe: async () => ({ id: 1, username: "bot" }),
  };
  const bot: TelegramBotLike = {
    api,
    use: () => undefined,
    start: async () => undefined,
    stop: async () => undefined,
  };
  return { bot, calls };
}

describe("channel-telegram lifecycle", () => {
  test("webhook full flow: claim → multi-handler dispatch → markProcessed → claim release window", async () => {
    const f = fakeBot();
    // Operator state: durable claim store + processed marker.
    const claims = new Map<number, "claimed" | "processed">();
    const events: string[] = [];
    const adapter = createTelegramChannel({
      token: "T",
      bot: f.bot,
      deployment: { mode: "webhook" },
      webhookSecret: "s",
      claimWebhookUpdate: (id) => {
        const cur = claims.get(id);
        if (cur === "processed") return "duplicate";
        if (cur === "claimed") return "duplicate";
        claims.set(id, "claimed");
        return "claimed";
      },
      releaseWebhookClaim: (id) => {
        if (claims.get(id) === "claimed") claims.delete(id);
      },
      markWebhookProcessed: (id) => {
        claims.set(id, "processed");
      },
    });
    await adapter.connect();
    adapter.onMessage(async (msg) => {
      events.push(`A:${msg.content[0]?.kind === "text" ? msg.content[0].text : "?"}`);
      await adapter.send({
        content: [{ kind: "text", text: "ack" }],
        threadId: String(msg.threadId),
      });
    });
    adapter.onMessage(async (msg) => {
      events.push(`B:${msg.content[0]?.kind === "text" ? msg.content[0].text : "?"}`);
    });

    const update1 = {
      update_id: 1,
      message: { message_id: 1, from: { id: 9 }, chat: { id: 200 }, date: 1, text: "hi" },
    };
    await adapter.handleWebhook("s", update1);
    // Both handlers ran, claim was committed, outbound ack was sent.
    expect(events).toEqual(["A:hi", "B:hi"]);
    expect(claims.get(1)).toBe("processed");
    expect(f.calls.filter((c) => c.method === "sendMessage")).toHaveLength(1);

    // Telegram retry of the same update — must short-circuit, no re-dispatch.
    await adapter.handleWebhook("s", update1);
    expect(events).toEqual(["A:hi", "B:hi"]);
    expect(f.calls.filter((c) => c.method === "sendMessage")).toHaveLength(1);

    // New update flows through cleanly.
    const update2 = {
      update_id: 2,
      message: { message_id: 2, from: { id: 9 }, chat: { id: 200 }, date: 1, text: "again" },
    };
    await adapter.handleWebhook("s", update2);
    expect(events).toEqual(["A:hi", "B:hi", "A:again", "B:again"]);
    expect(claims.get(2)).toBe("processed");

    await adapter.disconnect();
  });

  test("concurrent claims for same update_id: exactly one runs, others ACK silently", async () => {
    const f = fakeBot();
    // Atomic claim using a Set; first writer wins.
    const claimed = new Set<number>();
    let dispatchCount = 0;
    const adapter = createTelegramChannel({
      token: "T",
      bot: f.bot,
      deployment: { mode: "webhook" },
      webhookSecret: "s",
      claimWebhookUpdate: (id) => {
        if (claimed.has(id)) return "duplicate";
        claimed.add(id);
        return "claimed";
      },
      releaseWebhookClaim: (id) => {
        claimed.delete(id);
      },
    });
    await adapter.connect();
    adapter.onMessage(async () => {
      dispatchCount++;
    });
    const update = {
      update_id: 42,
      message: { message_id: 1, from: { id: 9 }, chat: { id: 200 }, date: 1, text: "x" },
    };
    // Three concurrent webhook deliveries (multi-instance race).
    await Promise.all([
      adapter.handleWebhook("s", update),
      adapter.handleWebhook("s", update),
      adapter.handleWebhook("s", update),
    ]);
    expect(dispatchCount).toBe(1);
    await adapter.disconnect();
  });

  test("button action containing ':' aborts BEFORE any media is sent (pre-validation invariant)", async () => {
    const f = fakeBot();
    const adapter = createTelegramChannel({ token: "T", bot: f.bot });
    await adapter.connect();
    // Image is BEFORE the bad button. Without pre-validation the photo
    // would already be in the user's chat by the time the button throws.
    await expect(
      adapter.send({
        content: [
          { kind: "image", url: "https://x/p.jpg", alt: "first" },
          { kind: "button", label: "ok", action: "tenant:approve" },
        ],
        threadId: "200",
      }),
    ).rejects.toThrow(/collides with the callback_data delimiter/);
    expect(f.calls).toHaveLength(0);
    await adapter.disconnect();
  });
});
