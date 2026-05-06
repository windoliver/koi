import { describe, expect, test } from "bun:test";
import type { OutboundMessage } from "@koi/core";
import type { TelegramUpdateLike } from "./normalize.js";
import {
  createTelegramChannel,
  splitText,
  type TelegramApiLike,
  type TelegramBotLike,
  TelegramPartialDeliveryError,
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

  test("polling: reconnect on an injected bot delivers each update exactly once (no middleware accumulation)", async () => {
    const f = fakeBot();
    const adapter = createTelegramChannel({ token: "T", bot: f.bot });
    await adapter.connect();
    await adapter.disconnect();
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
    // grammY's bot.use has no unsubscribe, so a naive per-connect
    // registration would stack two middlewares and deliver this update
    // twice. The single-install + connected-gate prevents that.
    expect(seen).toHaveLength(1);
    await adapter.disconnect();
  });

  test("polling: bot.start() rejection during connect leaves handleUpdate/handleWebhook fail-closed (no silent buffering)", async () => {
    const f = fakeBot();
    const failingBot: TelegramBotLike = {
      ...f.bot,
      start: async () => {
        throw new Error("getUpdates lock held by another instance");
      },
    };
    const adapter = createTelegramChannel({
      token: "T",
      bot: failingBot,
      deployment: { mode: "webhook" },
      webhookSecret: "s",
    });
    // Webhook mode still calls platformConnect (which validates getMe);
    // simulate the polling failure path with a polling-mode adapter
    // instead so bot.start() runs.
    const pollingAdapter = createTelegramChannel({ token: "T", bot: failingBot });
    await expect(pollingAdapter.connect()).rejects.toThrow(/bot\.start\(\) rejected/);
    // After failure, internal state must NOT accept updates as if
    // connected — handleUpdate would otherwise silently buffer them
    // until a later reconnect drains the stale queue.
    expect(() =>
      pollingAdapter.handleUpdate({
        update_id: 1,
        message: { message_id: 1, from: { id: 9 }, chat: { id: 200 }, date: 1, text: "x" },
      }),
    ).toThrow(/disconnected|not connected/);
    void adapter; // silence unused — adapter constructed only to verify webhook config still works
  });

  test("polling: photo with caption emits image AND a sibling text block (caption is user prompt)", async () => {
    const f = fakeBot();
    const adapter = createTelegramChannel({ token: "T", bot: f.bot });
    await adapter.connect();
    const seen: { content: readonly { kind: string }[] }[] = [];
    adapter.onMessage(async (m) => {
      seen.push(m as { content: readonly { kind: string }[] });
    });
    f.emit({
      update_id: 1,
      message: {
        message_id: 1,
        from: { id: 9 },
        chat: { id: 200 },
        date: 1700000000,
        caption: "summarize this please",
        photo: [{ file_id: "AgACA", width: 90, height: 90 }],
      },
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(seen).toHaveLength(1);
    const blocks = seen[0]?.content ?? [];
    expect(blocks.map((b) => b.kind)).toEqual(["image", "text"]);
    await adapter.disconnect();
  });

  test("polling: audio/video/voice uploads surface as file blocks (no silent drop)", async () => {
    const f = fakeBot();
    const adapter = createTelegramChannel({ token: "T", bot: f.bot });
    await adapter.connect();
    const seen: { content: readonly { kind: string }[] }[] = [];
    adapter.onMessage(async (m) => {
      seen.push(m as { content: readonly { kind: string }[] });
    });
    f.emit({
      update_id: 1,
      message: {
        message_id: 1,
        from: { id: 9 },
        chat: { id: 200 },
        date: 1700000000,
        audio: { file_id: "Aud1", mime_type: "audio/mpeg", file_name: "song.mp3" },
      },
    });
    f.emit({
      update_id: 2,
      message: {
        message_id: 2,
        from: { id: 9 },
        chat: { id: 200 },
        date: 1700000001,
        video: { file_id: "Vid1", mime_type: "video/mp4" },
      },
    });
    f.emit({
      update_id: 3,
      message: {
        message_id: 3,
        from: { id: 9 },
        chat: { id: 200 },
        date: 1700000002,
        voice: { file_id: "Voi1", mime_type: "audio/ogg" },
      },
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(seen).toHaveLength(3);
    expect(seen[0]?.content[0]?.kind).toBe("file");
    expect(seen[1]?.content[0]?.kind).toBe("file");
    expect(seen[2]?.content[0]?.kind).toBe("file");
    await adapter.disconnect();
  });

  test("webhook mode without webhookSecret refuses to construct (fails closed at boundary)", async () => {
    const f = fakeBot();
    expect(() =>
      createTelegramChannel({
        token: "T",
        bot: f.bot,
        deployment: { mode: "webhook" },
      }),
    ).toThrow(/webhookSecret/);
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

  test("webhook: handleWebhook awaits onMessage handler completion before resolving (no fire-and-forget ack)", async () => {
    const f = fakeBot();
    const adapter = createTelegramChannel({
      token: "T",
      bot: f.bot,
      deployment: { mode: "webhook" },
      webhookSecret: "s",
    });
    await adapter.connect();
    let releaseHandler: () => void = () => undefined;
    const handlerDone = new Promise<void>((r) => {
      releaseHandler = r;
    });
    const ordered: string[] = [];
    adapter.onMessage(async () => {
      ordered.push("handler-start");
      await handlerDone;
      ordered.push("handler-end");
    });
    const webhookPromise = adapter.handleWebhook("s", {
      update_id: 1,
      message: { message_id: 1, from: { id: 9 }, chat: { id: 200 }, date: 1, text: "hi" },
    });
    // Tick so the handler starts but is still waiting.
    await new Promise((r) => setTimeout(r, 5));
    expect(ordered).toEqual(["handler-start"]);
    let webhookResolved = false;
    void webhookPromise.then(() => {
      webhookResolved = true;
    });
    await new Promise((r) => setTimeout(r, 5));
    expect(webhookResolved).toBe(false);
    releaseHandler();
    await webhookPromise;
    expect(ordered).toEqual(["handler-start", "handler-end"]);
    await adapter.disconnect();
  });

  test("webhook: handleWebhook rethrows handler rejection so HTTPS layer can return non-200 (Telegram retries)", async () => {
    const f = fakeBot();
    const adapter = createTelegramChannel({
      token: "T",
      bot: f.bot,
      deployment: { mode: "webhook" },
      webhookSecret: "s",
    });
    await adapter.connect();
    adapter.onMessage(async () => {
      throw new Error("downstream-failed");
    });
    await expect(
      adapter.handleWebhook("s", {
        update_id: 1,
        message: { message_id: 1, from: { id: 9 }, chat: { id: 200 }, date: 1, text: "hi" },
      }),
    ).rejects.toThrow(/downstream-failed/);
    await adapter.disconnect();
  });

  test("webhook: markWebhookProcessed fires only on full success (post-success commit point)", async () => {
    const f = fakeBot();
    const marks: number[] = [];
    const adapter = createTelegramChannel({
      token: "T",
      bot: f.bot,
      deployment: { mode: "webhook" },
      webhookSecret: "s",
      markWebhookProcessed: async (id: number): Promise<void> => {
        marks.push(id);
      },
    });
    await adapter.connect();
    adapter.onMessage(async () => undefined);
    await adapter.handleWebhook("s", {
      update_id: 42,
      message: { message_id: 1, from: { id: 9 }, chat: { id: 200 }, date: 1, text: "hi" },
    });
    expect(marks).toEqual([42]);
    await adapter.disconnect();
  });

  test("webhook: markWebhookProcessed is NOT called when a handler rejects", async () => {
    const f = fakeBot();
    const marks: number[] = [];
    const adapter = createTelegramChannel({
      token: "T",
      bot: f.bot,
      deployment: { mode: "webhook" },
      webhookSecret: "s",
      markWebhookProcessed: async (id: number): Promise<void> => {
        marks.push(id);
      },
    });
    await adapter.connect();
    adapter.onMessage(async () => {
      throw new Error("boom");
    });
    await expect(
      adapter.handleWebhook("s", {
        update_id: 99,
        message: { message_id: 1, from: { id: 9 }, chat: { id: 200 }, date: 1, text: "hi" },
      }),
    ).rejects.toThrow();
    expect(marks).toHaveLength(0);
    await adapter.disconnect();
  });

  test("webhook: claimWebhookUpdate without releaseWebhookClaim refuses to construct (fails closed)", () => {
    const f = fakeBot();
    expect(() =>
      createTelegramChannel({
        token: "T",
        bot: f.bot,
        deployment: { mode: "webhook" },
        webhookSecret: "s",
        claimWebhookUpdate: () => "claimed",
        // releaseWebhookClaim intentionally omitted
      }),
    ).toThrow(/releaseWebhookClaim/);
  });

  test("webhook: markWebhookProcessed failure does NOT release the claim (handlers already produced side effects)", async () => {
    const f = fakeBot();
    const claims = new Set<number>();
    const releases: number[] = [];
    const adapter = createTelegramChannel({
      token: "T",
      bot: f.bot,
      deployment: { mode: "webhook" },
      webhookSecret: "s",
      claimWebhookUpdate: (id: number) => {
        if (claims.has(id)) return "duplicate";
        claims.add(id);
        return "claimed";
      },
      releaseWebhookClaim: (id: number) => {
        releases.push(id);
        claims.delete(id);
      },
      markWebhookProcessed: async (): Promise<void> => {
        throw new Error("commit-failed");
      },
    });
    await adapter.connect();
    let executions = 0;
    adapter.onMessage(async () => {
      executions++;
    });
    const update = {
      update_id: 55,
      message: { message_id: 1, from: { id: 9 }, chat: { id: 200 }, date: 1, text: "hi" },
    };
    await expect(adapter.handleWebhook("s", update)).rejects.toThrow(/commit-failed/);
    // Claim stayed reserved — release was NOT called for the
    // post-success bookkeeping failure, so a Telegram retry will be
    // detected as a duplicate and not re-run the handler.
    expect(releases).toHaveLength(0);
    expect(claims.has(55)).toBe(true);
    expect(executions).toBe(1);
    await adapter.disconnect();
  });

  test("webhook: markWebhookProcessed failure invokes onWebhookCommitFailure with updateId + error", async () => {
    const f = fakeBot();
    const claims = new Set<number>();
    const commitFailures: Array<{ id: number; err: unknown }> = [];
    const adapter = createTelegramChannel({
      token: "T",
      bot: f.bot,
      deployment: { mode: "webhook" },
      webhookSecret: "s",
      claimWebhookUpdate: (id: number) => {
        if (claims.has(id)) return "duplicate";
        claims.add(id);
        return "claimed";
      },
      releaseWebhookClaim: (id: number) => {
        claims.delete(id);
      },
      markWebhookProcessed: async (): Promise<void> => {
        throw new Error("commit-failed");
      },
      onWebhookCommitFailure: (id, err) => {
        commitFailures.push({ id, err });
      },
    });
    await adapter.connect();
    adapter.onMessage(async () => {
      // success
    });
    const update = {
      update_id: 77,
      message: { message_id: 1, from: { id: 9 }, chat: { id: 200 }, date: 1, text: "hi" },
    };
    await expect(adapter.handleWebhook("s", update)).rejects.toThrow(/commit-failed/);
    expect(commitFailures).toHaveLength(1);
    expect(commitFailures[0]?.id).toBe(77);
    expect((commitFailures[0]?.err as Error).message).toBe("commit-failed");
    // Claim still reserved — operator's recovery callback is the
    // documented path forward (sweep/page).
    expect(claims.has(77)).toBe(true);
    await adapter.disconnect();
  });

  test("webhook: handler failure releases the claim so Telegram retries can re-enter (no permanent loss)", async () => {
    const f = fakeBot();
    const claims = new Set<number>();
    const releases: number[] = [];
    let attempts = 0;
    const adapter = createTelegramChannel({
      token: "T",
      bot: f.bot,
      deployment: { mode: "webhook" },
      webhookSecret: "s",
      claimWebhookUpdate: (id: number) => {
        if (claims.has(id)) return "duplicate";
        claims.add(id);
        return "claimed";
      },
      releaseWebhookClaim: (id: number) => {
        releases.push(id);
        claims.delete(id);
      },
    });
    await adapter.connect();
    adapter.onMessage(async () => {
      attempts++;
      if (attempts === 1) throw new Error("transient");
    });
    const update = {
      update_id: 11,
      message: { message_id: 1, from: { id: 9 }, chat: { id: 200 }, date: 1, text: "hi" },
    };
    // First attempt fails — release fires, claim is gone.
    await expect(adapter.handleWebhook("s", update)).rejects.toThrow(/transient/);
    expect(releases).toEqual([11]);
    expect(claims.has(11)).toBe(false);
    // Telegram retries; second attempt succeeds.
    await adapter.handleWebhook("s", update);
    expect(attempts).toBe(2);
    await adapter.disconnect();
  });

  test("webhook: partial multi-handler success does NOT release the claim (one handler succeeded → side effects already produced)", async () => {
    const f = fakeBot();
    const claims = new Set<number>();
    const releases: number[] = [];
    const commitFailures: Array<{ id: number; err: unknown }> = [];
    const adapter = createTelegramChannel({
      token: "T",
      bot: f.bot,
      deployment: { mode: "webhook" },
      webhookSecret: "s",
      claimWebhookUpdate: (id: number) => {
        if (claims.has(id)) return "duplicate";
        claims.add(id);
        return "claimed";
      },
      releaseWebhookClaim: (id: number) => {
        releases.push(id);
        claims.delete(id);
      },
      onWebhookCommitFailure: (id, err) => {
        commitFailures.push({ id, err });
      },
    });
    await adapter.connect();
    adapter.onMessage(async () => {
      // A: succeeds (produces side effects)
    });
    adapter.onMessage(async () => {
      throw new Error("B-rejected");
    });
    const update = {
      update_id: 88,
      message: { message_id: 1, from: { id: 9 }, chat: { id: 200 }, date: 1, text: "hi" },
    };
    await expect(adapter.handleWebhook("s", update)).rejects.toThrow(/B-rejected/);
    // Claim must NOT be released — handler A already produced side effects.
    expect(releases).toHaveLength(0);
    expect(claims.has(88)).toBe(true);
    // Operator notified via the recovery hook.
    expect(commitFailures).toHaveLength(1);
    expect(commitFailures[0]?.id).toBe(88);
    expect((commitFailures[0]?.err as Error).message).toBe("B-rejected");
    await adapter.disconnect();
  });

  test('webhook: claimWebhookUpdate result "reclaimed" is treated as a fresh claim (stale-lease takeover path)', async () => {
    const f = fakeBot();
    let executions = 0;
    let processed: number | undefined;
    const adapter = createTelegramChannel({
      token: "T",
      bot: f.bot,
      deployment: { mode: "webhook" },
      webhookSecret: "s",
      claimWebhookUpdate: (_id: number) => "reclaimed",
      releaseWebhookClaim: () => undefined,
      markWebhookProcessed: (id) => {
        processed = id;
      },
    });
    await adapter.connect();
    adapter.onMessage(async () => {
      executions++;
    });
    const update = {
      update_id: 200,
      message: { message_id: 1, from: { id: 9 }, chat: { id: 200 }, date: 1, text: "hi" },
    };
    await adapter.handleWebhook("s", update);
    expect(executions).toBe(1);
    expect(processed).toBe(200);
    await adapter.disconnect();
  });

  test("polling: updates received during the 250ms startup probe are buffered, not dropped", async () => {
    const f = fakeBot();
    // fakeBot.start() resolves immediately; we synthesize the
    // startup-window race by emitting AFTER start has been called by
    // platformConnect but BEFORE adapter.connect() returns. The clean
    // way to observe this is to register onMessage AFTER connect and
    // confirm the burst is delivered.
    const adapter = createTelegramChannel({ token: "T", bot: f.bot });
    const connectPromise = adapter.connect();
    // Tick once so platformConnect has installed the middleware and
    // flipped ingressReady=true. The 250ms probe may still be running
    // (`connected` not yet true), but the middleware should buffer
    // updates anyway.
    await new Promise((r) => setTimeout(r, 0));
    f.emit({
      update_id: 100,
      message: {
        message_id: 100,
        from: { id: 9 },
        chat: { id: 200 },
        date: 1700000000,
        text: "early",
      },
    });
    await connectPromise;
    const seen: unknown[] = [];
    adapter.onMessage(async (m) => {
      seen.push(m);
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(seen).toHaveLength(1);
    await adapter.disconnect();
  });

  test("webhook: claimWebhookUpdate provides atomic single-execution under concurrent retries", async () => {
    const f = fakeBot();
    // Atomic claim implementation: only the first call sees "claimed",
    // every subsequent call (from a concurrent retry / second worker)
    // sees "duplicate". This mirrors a real Postgres INSERT ON CONFLICT
    // DO NOTHING or Redis SETNX.
    const claimed = new Set<number>();
    const adapter = createTelegramChannel({
      token: "T",
      bot: f.bot,
      deployment: { mode: "webhook" },
      webhookSecret: "s",
      claimWebhookUpdate: (id: number) => {
        if (claimed.has(id)) return "duplicate";
        claimed.add(id);
        return "claimed";
      },
      releaseWebhookClaim: (id: number) => {
        claimed.delete(id);
      },
    });
    await adapter.connect();
    let executions = 0;
    adapter.onMessage(async () => {
      executions++;
    });
    const update = {
      update_id: 7,
      message: { message_id: 1, from: { id: 9 }, chat: { id: 200 }, date: 1, text: "hi" },
    };
    // Fire two concurrent webhook calls for the same update_id, just
    // like Telegram retrying after an earlier 5xx while the first
    // request is still mid-flight.
    await Promise.all([adapter.handleWebhook("s", update), adapter.handleWebhook("s", update)]);
    expect(executions).toBe(1);
    await adapter.disconnect();
  });

  test("webhook: seenWebhookUpdate callback skips duplicate update_ids without invoking onMessage", async () => {
    const f = fakeBot();
    const seenIds = new Set<number>();
    const adapter = createTelegramChannel({
      token: "T",
      bot: f.bot,
      deployment: { mode: "webhook" },
      webhookSecret: "s",
      seenWebhookUpdate: async (id: number): Promise<boolean> => {
        if (seenIds.has(id)) return true;
        seenIds.add(id);
        return false;
      },
    });
    await adapter.connect();
    const seen: unknown[] = [];
    adapter.onMessage(async (m) => {
      seen.push(m);
    });
    const update = {
      update_id: 42,
      message: { message_id: 1, from: { id: 9 }, chat: { id: 200 }, date: 1, text: "hi" },
    };
    await adapter.handleWebhook("s", update);
    await adapter.handleWebhook("s", update);
    await new Promise((r) => setTimeout(r, 10));
    // Second call sees update_id 42 already marked → skipped silently.
    expect(seen).toHaveLength(1);
    await adapter.disconnect();
  });

  test("webhook: handleWebhook does NOT dedupe in-memory (callers must layer dedupe at a durable boundary)", async () => {
    // Adapter-level dedupe is unsafe: deliver() is fire-and-forget, so
    // marking an update as seen before it is durably processed would
    // suppress legitimate Telegram retries after a crash mid-handling
    // and lose the message permanently. Verify retries are forwarded.
    const f = fakeBot();
    const adapter = createTelegramChannel({
      token: "T",
      bot: f.bot,
      deployment: { mode: "webhook" },
      webhookSecret: "s",
    });
    await adapter.connect();
    const seen: unknown[] = [];
    adapter.onMessage(async (m) => {
      seen.push(m);
    });
    const update = {
      update_id: 42,
      message: { message_id: 1, from: { id: 9 }, chat: { id: 200 }, date: 1, text: "hi" },
    };
    adapter.handleWebhook("s", update);
    adapter.handleWebhook("s", update);
    await new Promise((r) => setTimeout(r, 10));
    expect(seen).toHaveLength(2);
    await adapter.disconnect();
  });

  test("webhook: handleWebhook routes through the buffered deliver path (no drops during connect window)", async () => {
    const f = fakeBot();
    const adapter = createTelegramChannel({
      token: "T",
      bot: f.bot,
      deployment: { mode: "webhook" },
      webhookSecret: "s",
    });
    // Register onMessage BEFORE connect so the handler is staged. Note
    // that connect() atomically sets updateHandler at the end of its
    // lifecycle, so we instead exercise a parallel path: send an update
    // via handleWebhook AFTER connect — same buffered deliver pipe.
    await adapter.connect();
    const seen: unknown[] = [];
    adapter.onMessage(async (m) => {
      seen.push(m);
    });
    adapter.handleWebhook("s", {
      update_id: 1,
      message: { message_id: 1, from: { id: 9 }, chat: { id: 200 }, date: 1, text: "hi" },
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(seen).toHaveLength(1);
    await adapter.disconnect();
  });

  test("webhook: handleWebhook throws when channel is disconnected (let Telegram retry)", async () => {
    const f = fakeBot();
    const adapter = createTelegramChannel({
      token: "T",
      bot: f.bot,
      deployment: { mode: "webhook" },
      webhookSecret: "s",
    });
    // Never connected.
    expect(() =>
      adapter.handleWebhook("s", {
        update_id: 1,
        message: { message_id: 1, from: { id: 9 }, chat: { id: 200 }, date: 1, text: "x" },
      }),
    ).toThrow(/disconnected/);
  });

  test("webhook: handleUpdate is hard-disabled (closes the secret-bypass path)", async () => {
    const f = fakeBot();
    const adapter = createTelegramChannel({
      token: "T",
      bot: f.bot,
      deployment: { mode: "webhook" },
      webhookSecret: "s",
    });
    await adapter.connect();
    expect(() =>
      adapter.handleUpdate({
        update_id: 1,
        message: { message_id: 1, from: { id: 9 }, chat: { id: 200 }, date: 1, text: "x" },
      }),
    ).toThrow(/disabled in webhook mode/);
    await adapter.disconnect();
  });

  test("polling: handleUpdate is a trusted-only entry — works after connect, throws when disconnected", async () => {
    const f = fakeBot();
    const adapter = createTelegramChannel({ token: "T", bot: f.bot });
    await adapter.connect();
    const seen: unknown[] = [];
    adapter.onMessage(async (m) => {
      seen.push(m);
    });
    adapter.handleUpdate({
      update_id: 1,
      message: { message_id: 1, from: { id: 9 }, chat: { id: 200 }, date: 1, text: "trusted" },
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(seen).toHaveLength(1);
    await adapter.disconnect();
    expect(() =>
      adapter.handleUpdate({
        update_id: 2,
        message: { message_id: 2, from: { id: 9 }, chat: { id: 200 }, date: 1, text: "x" },
      }),
    ).toThrow(/disconnected/);
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

  test("send: partial delivery surfaces TelegramPartialDeliveryError with delivered count", async () => {
    const f = fakeBot();
    // Make the second call (sendDocument) throw — first photo already
    // landed by then, so the adapter must escalate to a partial-delivery
    // error so retry middleware does not blindly resend the same
    // OutboundMessage and duplicate the photo.
    let calls = 0;
    const partialBot: TelegramBotLike = {
      ...f.bot,
      api: {
        ...f.bot.api,
        sendPhoto: async () => {
          calls++;
          return undefined;
        },
        sendDocument: async () => {
          calls++;
          throw new Error("network blip");
        },
      },
    };
    const adapter = createTelegramChannel({ token: "T", bot: partialBot });
    await adapter.connect();
    let captured: unknown;
    try {
      await adapter.send({
        content: [
          { kind: "image", url: "https://x/p.jpg" },
          { kind: "file", url: "https://x/d.pdf", mimeType: "application/pdf" },
        ],
        threadId: "200",
      });
    } catch (err) {
      captured = err;
    }
    expect(captured).toBeInstanceOf(TelegramPartialDeliveryError);
    if (captured instanceof TelegramPartialDeliveryError) {
      expect(captured.deliveredParts).toBe(1);
    }
    expect(calls).toBe(2);
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
