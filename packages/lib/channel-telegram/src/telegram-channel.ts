/**
 * @koi/channel-telegram — grammy ChannelAdapter factory.
 *
 * Polling and webhook deployments. Polling drives a long-running update
 * loop; webhook exposes `handleUpdate(update)` so the caller's HTTPS
 * handler can forward updates without owning the bot's transport.
 */

import { createChannelAdapter } from "@koi/channel-base";
import type { ChannelAdapter, ChannelCapabilities, OutboundMessage } from "@koi/core";
import type { TelegramUpdateLike } from "./normalize.js";
import { createNormalizer } from "./normalize.js";

export type TelegramDeployment = { readonly mode: "polling" } | { readonly mode: "webhook" };

/** Subset of grammY's `Context`. We only need the raw Update. */
export interface TelegramContextLike {
  readonly update: TelegramUpdateLike;
}

/**
 * Bot-like surface required by the adapter. Subset of grammY's `Bot`.
 *
 * grammY does not expose `on(event, handler) => unsubscribe`. The supported
 * extension point is `use(middleware)` (and friends), which has no
 * unsubscribe semantics — once registered, middleware runs for the life of
 * the bot. We rely on a captured guard variable inside `onPlatformEvent` to
 * stop dispatching after the listener tears down.
 */
export interface TelegramBotLike {
  readonly api: TelegramApiLike;
  /** Register middleware to observe every update. Return value is ignored. */
  use(
    middleware: (ctx: TelegramContextLike, next: () => Promise<void>) => Promise<void> | void,
  ): unknown;
  start(): Promise<void>;
  stop(): Promise<void>;
}

/**
 * grammY uses mutable array shapes for inline keyboards, so this type is
 * intentionally non-readonly to remain assignable from a real `Bot.api`
 * call. The payload object we construct is single-use and never shared.
 */
export interface TelegramReplyMarkup {
  inline_keyboard: TelegramInlineButton[][];
}

export interface TelegramInlineButton {
  readonly text: string;
  readonly callback_data: string;
}

export interface TelegramSendMessageOther {
  readonly message_thread_id?: number;
  readonly reply_markup?: TelegramReplyMarkup;
}

export interface TelegramSendPhotoOther {
  readonly caption?: string;
  readonly message_thread_id?: number;
}

export interface TelegramSendDocumentOther {
  readonly caption?: string;
  readonly message_thread_id?: number;
}

/**
 * Subset of grammY's `Api`. Methods use grammY's positional shape:
 * `sendMessage(chat_id, text, other?)` rather than an options bag, so a real
 * `Bot` instance is assignable to this type without an adapter shim.
 */
export interface TelegramApiLike {
  sendMessage(chat_id: number, text: string, other?: TelegramSendMessageOther): Promise<unknown>;
  sendPhoto(chat_id: number, photo: string, other?: TelegramSendPhotoOther): Promise<unknown>;
  sendDocument(
    chat_id: number,
    document: string,
    other?: TelegramSendDocumentOther,
  ): Promise<unknown>;
  getFile(file_id: string): Promise<{ readonly file_path?: string }>;
  answerCallbackQuery(callback_query_id: string): Promise<unknown>;
  /** Returns the bot's identity. Used as a connect-time handshake. */
  getMe(): Promise<{ readonly id: number; readonly username?: string }>;
}

export interface TelegramChannelConfig {
  readonly token: string;
  readonly deployment?: TelegramDeployment;
  /**
   * Webhook mode only — the secret-token Telegram sends in the
   * `X-Telegram-Bot-Api-Secret-Token` header (set via `setWebhook`).
   * When set, `handleWebhook(headerValue, update)` requires this exact
   * value before forwarding the update; mismatches throw and the update
   * is dropped. Required for production webhook mode — without it any
   * caller that gets the public webhook URL can spoof updates.
   */
  readonly webhookSecret?: string;
  /** Test-only injected bot double. */
  readonly bot?: TelegramBotLike;
  readonly onHandlerError?: (err: unknown, ctx: unknown) => void;
  /**
   * Optional replay barrier for webhook mode. Telegram retries the same
   * `update_id` after timeouts/5xx/network blips, so without dedupe a
   * single user message can fire the agent loop multiple times. Return
   * `true` to indicate the `update_id` has already been processed and
   * should be skipped; the adapter will swallow it and the HTTPS handler
   * can return 200 to stop further retries.
   *
   * The callback MUST be backed by durable storage (DB, Redis, queue
   * dedupe table) and the seen-marker MUST be written only after
   * downstream processing has succeeded. An in-memory mark-on-receive
   * Set will silently suppress legitimate retries after a crash and
   * cause permanent message loss.
   */
  readonly seenWebhookUpdate?: (updateId: number) => boolean | Promise<boolean>;
  /**
   * Atomic-claim alternative to `seenWebhookUpdate`. When set, this is
   * called instead of `seenWebhookUpdate` and MUST atomically reserve
   * the `update_id` in a way that two concurrent calls — whether from
   * Telegram retries, multi-instance webhook delivery, or load-balanced
   * workers — return `"claimed"` for exactly one of them and
   * `"duplicate"` for the rest. Implementations typically wrap an
   * `INSERT ... ON CONFLICT DO NOTHING` (Postgres), `SET NX`
   * (Redis), or a queue dedupe table; a non-atomic in-memory Set is
   * UNSAFE and defeats the contract.
   *
   * On `"duplicate"` the adapter swallows the update silently so the
   * HTTPS handler can return 200 and stop the retry chain. On
   * `"claimed"` the adapter dispatches the update through every
   * onMessage handler, awaits completion, and only then calls
   * `markWebhookProcessed` (if configured) so callers can advance
   * the row from `claimed` → `processed` under their own
   * transaction.
   *
   * Prefer this over `seenWebhookUpdate`: the older check-then-act
   * shape lets two concurrent retries both observe `seen=false` and
   * fan out duplicate agent turns. When both are set,
   * `claimWebhookUpdate` wins.
   *
   * Result `"reclaimed"` is treated identically to `"claimed"` and
   * exists so operators can implement lease/TTL semantics: when a
   * worker crashes after writing the claim row but before commit or
   * release, the row is left as a stale lease. A later retry whose
   * lease is older than the operator's TTL can be returned as
   * `"reclaimed"` so processing resumes instead of being silently
   * ACKed as a duplicate forever. Operators that do not implement
   * lease/TTL recovery may simply never return `"reclaimed"`.
   */
  readonly claimWebhookUpdate?: (
    updateId: number,
  ) => "claimed" | "duplicate" | "reclaimed" | Promise<"claimed" | "duplicate" | "reclaimed">;
  /**
   * Release a previously-claimed `update_id` so a Telegram retry can
   * re-enter. Required when `claimWebhookUpdate` is set: if a handler
   * rejects (or `markWebhookProcessed` itself fails) we fire this hook
   * so the operator's claim row can be deleted/expired and the next
   * Telegram retry sees `"claimed"` again instead of being permanently
   * suppressed as a duplicate. Without it, a transient downstream
   * failure becomes permanent message loss because the durable claim
   * row outlives the failed processing attempt.
   *
   * Implementations MUST be idempotent — release may run for a claim
   * that was never persisted (race between claim write and process
   * crash), and may run more than once if cleanup itself fails.
   */
  readonly releaseWebhookClaim?: (updateId: number) => void | Promise<void>;
  /**
   * Optional post-success commit hook for webhook mode. After
   * `handleWebhook(...)` has awaited every registered onMessage
   * handler to completion, this callback fires so the operator can
   * durably mark `update_id` as processed under the same transaction
   * boundary that produced the user-visible side effects. Pairs with
   * `seenWebhookUpdate` to give callers a real two-phase
   * reserve/commit boundary: pre-check skips already-committed
   * retries, post-success commit marks the new update.
   *
   * `handleWebhook` only invokes this callback when every handler
   * resolved successfully. If any handler rejected, the callback is
   * SKIPPED and `handleWebhook` rethrows so the HTTPS layer can
   * return non-200 and let Telegram retry.
   */
  readonly markWebhookProcessed?: (updateId: number) => void | Promise<void>;
  /**
   * Fires when `markWebhookProcessed` itself throws AFTER every handler
   * has succeeded. The handlers already produced user-visible side
   * effects, so the claim cannot simply be released (Telegram retries
   * would re-run them and duplicate). But leaving the update silently
   * "claimed but never processed" hides the inconsistency from
   * operators. This callback is the recovery hook: enqueue a sweep,
   * page oncall, or write a "needs-reconciliation" row keyed on
   * `updateId`. The original commit error is rethrown after the
   * callback returns so the HTTPS layer still returns non-200.
   *
   * Errors raised by this callback are logged to stderr and
   * swallowed — surfacing them would mask the underlying commit
   * failure (which is the actionable signal).
   */
  readonly onWebhookCommitFailure?: (updateId: number, err: unknown) => void | Promise<void>;
}

export interface TelegramChannelAdapter extends ChannelAdapter {
  /**
   * Direct dispatch entrypoint for already-trusted, in-process sources
   * (tests, an internal queue, an upstream verifier). Performs NO
   * authenticity check. PRODUCTION webhook integrations MUST use
   * `handleWebhook`, which verifies the
   * `X-Telegram-Bot-Api-Secret-Token` header in constant time before
   * dispatching. Throws when the channel is disconnected.
   */
  readonly handleUpdate: (update: TelegramUpdateLike) => void;
  /**
   * Webhook mode only — verifies the
   * `X-Telegram-Bot-Api-Secret-Token` header against the configured
   * `webhookSecret`, then dispatches the update. Throws when the
   * adapter has no `webhookSecret` configured (fail closed: explicit
   * setup required for production) or when the header does not match.
   */
  readonly handleWebhook: (
    secretHeaderValue: string | undefined,
    update: TelegramUpdateLike,
  ) => Promise<void>;
  /**
   * Resolves an inbound `tg://file/<fileId>` reference (or a bare file_id) to
   * a short-lived token-bearing download URL. Call this only at the fetch
   * site; never log or surface the result.
   */
  readonly resolveMediaUrl: (fileIdOrTgUrl: string) => Promise<string>;
}

const TELEGRAM_CAPABILITIES: ChannelCapabilities = {
  text: true,
  images: true,
  files: true,
  buttons: true,
  audio: false,
  video: false,
  threads: true,
  supportsA2ui: false,
};

const TEXT_LIMIT = 4096;

export function createTelegramChannel(config: TelegramChannelConfig): TelegramChannelAdapter {
  const deployment: TelegramDeployment = config.deployment ?? { mode: "polling" };
  // Fail closed at construction. Webhook mode without a configured secret
  // is the most common way operators accidentally ship an unauthenticated
  // public ingress route. Refuse to construct rather than leaving the
  // verification optional and hoping callers wire handleWebhook
  // correctly.
  if (deployment.mode === "webhook" && config.webhookSecret === undefined) {
    throw new Error(
      "[channel-telegram] webhook mode requires `webhookSecret` in TelegramChannelConfig (the value also passed to setWebhook). Without it any caller hitting the webhook URL can spoof updates.",
    );
  }
  // claimWebhookUpdate without a release path turns any transient
  // handler failure into permanent message loss: the durable claim
  // row outlives the failed attempt and every Telegram retry hits
  // "duplicate". Refuse the unsafe configuration at construction.
  if (config.claimWebhookUpdate !== undefined && config.releaseWebhookClaim === undefined) {
    throw new Error(
      "[channel-telegram] claimWebhookUpdate requires releaseWebhookClaim in TelegramChannelConfig — without a release path, any handler failure permanently suppresses Telegram retries for that update_id and the message is lost.",
    );
  }
  // let requires justification: bot is created lazily inside platformConnect
  let bot: TelegramBotLike | undefined = config.bot;
  // let requires justification: registered listener invoked by handleUpdate
  let updateHandler: ((update: TelegramUpdateLike) => void) | undefined;
  // let requires justification: tracks the channel's connect/disconnect
  // edge so handleUpdate / handleWebhook can fail closed when called
  // before connect() or after disconnect(). Cannot rely on `bot` alone
  // because callers may inject a long-lived bot via config.bot.
  let connected = false;
  // Buffer for updates that arrive between b.start() (kicked off in
  // platformConnect) and onPlatformEvent installing updateHandler. The
  // window is the brief gap inside @koi/channel-base's connect() between
  // platformConnect resolving and onPlatformEvent being called — measured
  // in milliseconds. We do NOT cap the buffer: silently truncating older
  // updates during a reconnect burst causes user-visible message loss
  // with no signal. If the buffer grows unboundedly that means
  // onPlatformEvent never fires (a bug in the host) — surface it via OOM
  // rather than mask it by dropping inbound traffic.
  // let requires justification: drained when updateHandler is installed.
  let pending: TelegramUpdateLike[] = [];
  // grammY has no middleware-unsubscribe API (`bot.use` runs for the
  // life of the bot). When a caller injects a long-lived bot via
  // config.bot, naive per-connect registration would stack a fresh
  // dispatcher every reconnect; once a single update is delivered it
  // would fan out through every stale registration and trigger
  // duplicate agent turns. We install our dispatcher exactly ONCE per
  // bot instance and gate dispatch on the adapter's `connected` flag
  // so it lies dormant between connect cycles and resumes when the
  // adapter is reconnected.
  const wiredBots: WeakSet<TelegramBotLike> = new WeakSet();
  // True only when this adapter created the bot itself. Injected
  // (caller-owned) bots survive disconnect so the next connect can
  // reuse the same wired middleware registration.
  // let requires justification: flipped at platformConnect when we
  // instantiate; remains false for injected bots throughout.
  let botOwnedByAdapter = false;
  // Polling-mode ingress gate. The dispatch middleware uses this
  // (NOT `connected`) to decide whether to buffer/forward updates.
  // We flip ingressReady to true BEFORE calling bot.start() so any
  // updates Telegram delivers immediately after start (typical for
  // backlog after reconnect) land in `pending` instead of being
  // silently dropped during the 250ms startup probe; without this,
  // those updates are consumed by Telegram with no retry path.
  // `connected` still gates handleUpdate / handleWebhook so external
  // ingress is only accepted after the probe survives.
  // let requires justification: flipped to true before bot.start,
  // back to false in platformDisconnect.
  let ingressReady = false;

  const deliver = (update: TelegramUpdateLike): void => {
    if (updateHandler !== undefined) {
      updateHandler(update);
      return;
    }
    pending.push(update);
  };

  const requireBot = (): TelegramBotLike => {
    if (bot === undefined) throw new Error("[channel-telegram] not connected");
    return bot;
  };

  const normalize = createNormalizer({
    // Emit an opaque `tg://file/<fileId>` reference rather than the
    // token-bearing CDN URL. The Bot API's media URLs embed the bot token,
    // so leaking them downstream (logs, model prompts, middleware) would
    // expose a bearer-equivalent secret. Consumers that need to download
    // media call back into the adapter via `resolveMediaUrl(fileId)`.
    getFileUrl: async (fileId: string): Promise<string> => `tg://file/${fileId}`,
    answerCallbackQuery: async (id: string): Promise<void> => {
      await requireBot().api.answerCallbackQuery(id);
    },
  });

  /**
   * Resolves an opaque `tg://file/<fileId>` reference to a short-lived,
   * token-bearing download URL. Use this only at the actual fetch site —
   * never store, log, or surface the result.
   */
  const resolveMediaUrl = async (fileIdOrTgUrl: string): Promise<string> => {
    const fileId = fileIdOrTgUrl.startsWith("tg://file/")
      ? fileIdOrTgUrl.slice("tg://file/".length)
      : fileIdOrTgUrl;
    const info = await requireBot().api.getFile(fileId);
    if (info.file_path === undefined) {
      throw new Error(`[channel-telegram] file_path unavailable for "${fileId}"`);
    }
    return `https://api.telegram.org/file/bot${config.token}/${info.file_path}`;
  };

  // let requires justification: forward-declared so the post-startup
  // rejection path can call disconnect() to revoke the channel's connected
  // state; assigned right after createChannelAdapter returns.
  let adapter: TelegramChannelAdapter | undefined;

  const base = createChannelAdapter<TelegramUpdateLike>({
    name: "telegram",
    capabilities: TELEGRAM_CAPABILITIES,

    platformConnect: async (): Promise<void> => {
      if (bot === undefined) {
        bot = await instantiateBot(config.token);
        botOwnedByAdapter = true;
      }
      // Connect-time handshake: validate the bot token by calling getMe.
      await bot.api.getMe();
      if (deployment.mode === "polling") {
        const b = bot;
        // Install dispatcher middleware exactly once per bot instance.
        // Gated by `connected` so it stays dormant between connect
        // cycles and does not fan out duplicate updates through stale
        // registrations on reconnect with an injected bot.
        if (!wiredBots.has(b)) {
          wiredBots.add(b);
          b.use(async (ctx, next): Promise<void> => {
            if (ingressReady) deliver(ctx.update);
            await next();
          });
        }
        // Flip ingress ON before bot.start so the middleware buffers
        // any updates Telegram drains in the first 250ms — `pending`
        // collects them and onPlatformEvent will drain them once the
        // base factory installs its handler.
        ingressReady = true;
        // grammY's bot.start() is the long-poll loop and only resolves on
        // stop(). Race it against a short startup window so connect() fails
        // fast when polling startup itself rejects (e.g. another instance
        // holds the getUpdates lock, or the binary cannot reach Telegram).
        // Without this race, connect() would resolve while polling silently
        // wedged, leaving the channel in a false-healthy state with no
        // inbound traffic and no rollback path.
        const startPromise = b.start();
        const STARTUP_WINDOW_MS = 250;
        const result = await Promise.race<"alive" | { rejected: unknown }>([
          startPromise
            .then((): "alive" => "alive")
            .catch((err: unknown): { rejected: unknown } => ({ rejected: err })),
          new Promise<"alive">((resolve) => setTimeout(() => resolve("alive"), STARTUP_WINDOW_MS)),
        ]);
        if (typeof result === "object") {
          // Polling rejected immediately. Tear back down so we don't leak
          // a half-initialized bot into the rest of the lifecycle. Clear
          // any updates the dispatcher buffered during the racing
          // start() — connect() never completed, so there is no
          // legitimate consumer for them.
          bot = undefined;
          ingressReady = false;
          pending = [];
          throw new Error(
            `[channel-telegram] bot.start() rejected during connect: ${String(result.rejected)}`,
            { cause: result.rejected },
          );
        }
        // Polling startup probe survived — flip the gate ON only now.
        // Setting `connected` earlier would have allowed handleUpdate /
        // handleWebhook to accept traffic during a connect that may
        // still reject in the startup window, leaving silently buffered
        // updates that survive into a later reconnect.
        connected = true;
        // Polling is alive. Continue draining `start()` in the background.
        // A late rejection (network drop, auth revocation, server kicked
        // us off) is channel-fatal: revoke the adapter's connected state
        // so the runtime stops trusting it and inbound silence becomes
        // observable instead of a hidden blackhole. The user's
        // onHandlerError hook still fires for reconnect logic; if no hook
        // is provided we log so the outage cannot remain silent.
        void startPromise.catch((err: unknown) => {
          if (config.onHandlerError !== undefined) {
            config.onHandlerError(err, { phase: "polling" });
          } else {
            console.error("[channel-telegram] polling loop terminated:", err);
          }
          adapter?.disconnect().catch((teardownErr: unknown) => {
            console.error(
              "[channel-telegram] disconnect after polling failure failed:",
              teardownErr,
            );
          });
        });
      } else {
        // Webhook mode has no startup probe — flip the gate immediately.
        connected = true;
      }
    },

    platformDisconnect: async (): Promise<void> => {
      connected = false;
      ingressReady = false;
      if (bot === undefined) return;
      if (deployment.mode === "polling") {
        await bot.stop();
      }
      updateHandler = undefined;
      pending = [];
      // Only release adapter-owned bots. Injected (caller-owned) bots
      // stay alive across disconnect so a later connect() can reuse
      // the same instance — the dispatcher middleware is already
      // wired (see wiredBots) and gated by `connected`.
      if (botOwnedByAdapter) {
        bot = undefined;
        botOwnedByAdapter = false;
      }
    },

    platformSend: async (message: OutboundMessage): Promise<void> => {
      await sendOutbound(requireBot().api, message);
    },

    onPlatformEvent: (handler): (() => void) => {
      // grammY's `bot.use()` has no unsubscribe — middleware runs for the
      // life of the bot. The `active` flag below is the only stop signal
      // honoured after teardown; without it, late updates from the polling
      // loop would invoke a stale handler after disconnect().
      // let requires justification: flipped to false by the returned cleanup
      let active = true;
      const dispatch = (update: TelegramUpdateLike): void => {
        if (active) handler(update);
      };
      updateHandler = dispatch;
      // Drain updates that arrived between b.start() (in platformConnect)
      // and this handler install.
      const drained = pending;
      pending = [];
      for (const u of drained) dispatch(u);
      return (): void => {
        active = false;
        updateHandler = undefined;
      };
    },

    normalize,
    ...(config.onHandlerError !== undefined && { onHandlerError: config.onHandlerError }),
  });

  // Webhook-mode awaitable dispatch. We track onMessage handlers
  // locally so `handleWebhook` can normalize + dispatch + AWAIT the
  // full chain, then return success only after every handler
  // resolved. channel-base's dispatcher is fire-and-forget through
  // the platform-event path; routing webhook updates through it
  // would force `handleWebhook` to ack before processing finished
  // (the original "fire-and-forget" defect).
  // let requires justification: mutates as callers (un)subscribe
  type LocalHandler = (msg: import("@koi/core").InboundMessage) => Promise<void>;
  let webhookHandlers: ReadonlyArray<{ readonly id: number; readonly fn: LocalHandler }> = [];
  // let requires justification: monotonic counter for handler ids
  let nextWebhookHandlerId = 0;
  const wrappedOnMessage = (handler: LocalHandler): (() => void) => {
    const id = nextWebhookHandlerId++;
    webhookHandlers = [...webhookHandlers, { id, fn: handler }];
    const unsubBase = base.onMessage(handler);
    return (): void => {
      webhookHandlers = webhookHandlers.filter((h) => h.id !== id);
      unsubBase();
    };
  };

  type DispatchResult =
    | { readonly kind: "skipped" }
    | { readonly kind: "no-handlers" }
    | { readonly kind: "ok" }
    | { readonly kind: "rejected"; readonly fulfilled: number; readonly error: Error };
  const dispatchWebhook = async (update: TelegramUpdateLike): Promise<DispatchResult> => {
    const msg = await normalize(update);
    if (msg === null) return { kind: "skipped" };
    const handlers = webhookHandlers;
    if (handlers.length === 0) return { kind: "no-handlers" };
    const results = await Promise.allSettled(handlers.map((h) => h.fn(msg)));
    let fulfilled = 0;
    let rejected: PromiseRejectedResult | undefined;
    for (const r of results) {
      if (r.status === "fulfilled") fulfilled++;
      else if (rejected === undefined) rejected = r;
    }
    if (rejected !== undefined) {
      const error =
        rejected.reason instanceof Error ? rejected.reason : new Error(String(rejected.reason));
      return { kind: "rejected", fulfilled, error };
    }
    return { kind: "ok" };
  };

  adapter = {
    ...base,
    onMessage: wrappedOnMessage,
    handleUpdate: (update: TelegramUpdateLike): void => {
      // In webhook mode `handleUpdate` is hard-disabled. The same
      // adapter instance must not expose two ingress paths — one
      // verified (`handleWebhook`) and one not (`handleUpdate`) — or a
      // single bad route wiring (`adapter.handleUpdate(req.body)`)
      // silently bypasses authenticity. Production webhook callers go
      // through `handleWebhook`. In polling mode `handleUpdate` is a
      // trusted in-process entrypoint for tests / verified queues.
      if (deployment.mode === "webhook") {
        throw new Error(
          "[channel-telegram] handleUpdate is disabled in webhook mode — use handleWebhook(secretHeaderValue, update) so the X-Telegram-Bot-Api-Secret-Token header is verified",
        );
      }
      if (!connected) {
        throw new Error(
          "[channel-telegram] handleUpdate called while disconnected — refusing to swallow update silently",
        );
      }
      deliver(update);
    },
    handleWebhook: async (secretHeaderValue, update): Promise<void> => {
      if (config.webhookSecret === undefined) {
        throw new Error(
          "[channel-telegram] handleWebhook requires `webhookSecret` in TelegramChannelConfig — refusing to dispatch unauthenticated update",
        );
      }
      if (
        secretHeaderValue === undefined ||
        !timingSafeEqual(secretHeaderValue, config.webhookSecret)
      ) {
        throw new Error(
          "[channel-telegram] handleWebhook secret mismatch — dropping update (X-Telegram-Bot-Api-Secret-Token header missing or incorrect)",
        );
      }
      // Fail closed when the channel is disconnected: webhook callers
      // can return a non-200 and let Telegram retry rather than silently
      // ack-and-drop the update.
      if (!connected) {
        throw new Error(
          "[channel-telegram] handleWebhook called while disconnected — return a non-200 so Telegram retries",
        );
      }
      // Two-phase reserve/commit:
      //   1. seenWebhookUpdate (pre-check) skips updates that are
      //      already committed in the operator's durable store.
      //   2. dispatchWebhook awaits every onMessage handler so this
      //      function only resolves after end-to-end processing
      //      succeeds — handler rejection becomes a thrown error so
      //      the HTTPS layer can return non-200 and Telegram retries.
      //   3. markWebhookProcessed (post-commit) fires only on full
      //      success so the operator can durably mark the update_id
      //      under the same transaction that produced the side
      //      effects.
      // Atomic claim wins when both are configured — see the
      // claimWebhookUpdate doc for why check-then-act seenWebhookUpdate
      // is unsafe under concurrent retries.
      const usedClaim = config.claimWebhookUpdate !== undefined;
      if (usedClaim && config.claimWebhookUpdate !== undefined) {
        const result = await config.claimWebhookUpdate(update.update_id);
        if (result === "duplicate") return;
      } else if (config.seenWebhookUpdate !== undefined) {
        const seen = await config.seenWebhookUpdate(update.update_id);
        if (seen) return;
      }
      // Handler-stage failures fall into two categories:
      //   - ALL handlers rejected (or no handlers ran): release the
      //     claim so Telegram retries can re-enter — no side effects
      //     were produced.
      //   - At least one handler succeeded but another rejected
      //     (partial side effects): MUST NOT release. Releasing would
      //     let Telegram's retry re-run the successful handler and
      //     duplicate replies/tool-calls/external writes. Surface as
      //     a commit failure to onWebhookCommitFailure so the
      //     operator can recover (sweep, page) and rethrow so the
      //     HTTPS layer returns non-200.
      // Post-handler failures (markWebhookProcessed throws AFTER all
      // handlers succeeded) follow the same "claim stays reserved"
      // rule for the same reason.
      const dispatchResult = await dispatchWebhook(update);
      if (dispatchResult.kind === "no-handlers") {
        // Fail closed: an update arrived before any onMessage handler
        // was wired (startup race, rolling restart, mis-ordered
        // composition). Returning success here would silently lose the
        // update — Telegram would stop retrying and the message would
        // never reach a handler. Release the claim (no side effects
        // were produced) and throw so the HTTPS layer returns non-200
        // and Telegram retries when handlers are wired.
        if (usedClaim && config.releaseWebhookClaim !== undefined) {
          try {
            await config.releaseWebhookClaim(update.update_id);
          } catch (releaseErr: unknown) {
            console.error(
              `[channel-telegram] releaseWebhookClaim(${update.update_id}) failed during no-handler fail-closed:`,
              releaseErr,
            );
          }
        }
        throw new Error(
          "[channel-telegram] handleWebhook received an update before any onMessage handler was registered — refusing to ACK so Telegram retries (wire onMessage before exposing the webhook route)",
        );
      }
      if (dispatchResult.kind === "rejected") {
        if (dispatchResult.fulfilled === 0) {
          if (usedClaim && config.releaseWebhookClaim !== undefined) {
            try {
              await config.releaseWebhookClaim(update.update_id);
            } catch (releaseErr: unknown) {
              console.error(
                `[channel-telegram] releaseWebhookClaim(${update.update_id}) failed after handler error:`,
                releaseErr,
              );
            }
          }
        } else if (config.onWebhookCommitFailure !== undefined) {
          try {
            await config.onWebhookCommitFailure(update.update_id, dispatchResult.error);
          } catch (hookErr: unknown) {
            console.error(
              `[channel-telegram] onWebhookCommitFailure(${update.update_id}) threw; original handler error rethrown:`,
              hookErr,
            );
          }
        }
        throw dispatchResult.error;
      }
      if (config.markWebhookProcessed !== undefined) {
        // Errors here surface to the HTTPS layer (non-200 → Telegram
        // retry) but the claim STAYS reserved: handlers already ran.
        // The retry, when it arrives, will be caught by the operator's
        // claim store as duplicate and silently 200'd, breaking the
        // retry chain without re-running side effects. The
        // onWebhookCommitFailure hook gives operators a synchronous
        // recovery path (enqueue sweep, page oncall) so the half-
        // committed update_id is not invisible.
        try {
          await config.markWebhookProcessed(update.update_id);
        } catch (commitErr: unknown) {
          if (config.onWebhookCommitFailure !== undefined) {
            try {
              await config.onWebhookCommitFailure(update.update_id, commitErr);
            } catch (hookErr: unknown) {
              console.error(
                `[channel-telegram] onWebhookCommitFailure(${update.update_id}) threw; original commit error rethrown:`,
                hookErr,
              );
            }
          }
          throw commitErr;
        }
      }
    },
    resolveMediaUrl,
  };
  return adapter;
}

/**
 * Constant-time comparison to prevent secret-token timing leaks. Both
 * arguments must be equal-length strings to compare equal; differing
 * lengths short-circuit to false.
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  // let requires justification: XOR-accumulator over byte differences
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

export function splitText(s: string, limit: number): readonly string[] {
  if (s.length <= limit) return [s];
  const out: string[] = [];
  // let requires justification: walks the input slicing into <= limit chunks
  let rest = s;
  while (rest.length > limit) {
    const breakAt = rest.lastIndexOf("\n", limit);
    const cut = breakAt > limit / 2 ? breakAt : limit;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, "");
  }
  if (rest.length > 0) out.push(rest);
  return out;
}

async function sendOutbound(api: TelegramApiLike, message: OutboundMessage): Promise<void> {
  if (message.threadId === undefined) {
    throw new Error("[channel-telegram] OutboundMessage.threadId is required");
  }
  if (message.threadId.startsWith("inline:")) {
    throw new Error(
      `[channel-telegram] cannot reply on inline-mode threadId "${message.threadId}" — there is no chat context. Use editMessageText with inline_message_id outside this adapter.`,
    );
  }
  const { chatId, threadId } = parseThreadId(message.threadId);

  // Pre-validate ALL button callback_data BEFORE any side-effecting API
  // call. Photos and documents are non-revertible — if a later button
  // payload turned out to exceed Telegram's 64-byte limit, the user
  // would see an orphaned attachment with no explanatory text. Encoding
  // now throws synchronously and aborts the whole send before any media
  // leaves. Walk the original block order; we emit API calls in that
  // same order below so a `[text, image, text, button]` message
  // arrives as text → image → text+button, NOT image → all-text.
  for (const b of message.content) {
    if (b.kind === "button") encodeCallbackData(b.action, b.payload);
  }

  const photoOther = (alt: string | undefined): TelegramSendPhotoOther | undefined => {
    const o: { -readonly [K in keyof TelegramSendPhotoOther]: TelegramSendPhotoOther[K] } = {};
    if (alt !== undefined) o.caption = alt;
    if (threadId !== undefined) o.message_thread_id = threadId;
    return Object.keys(o).length > 0 ? o : undefined;
  };
  const docOther = (): TelegramSendDocumentOther | undefined =>
    threadId !== undefined ? { message_thread_id: threadId } : undefined;

  // Multi-call sends are not transactional: a transient failure mid-way
  // leaves earlier parts already delivered to the user. Track how many
  // parts succeeded so the error we throw tells callers exactly how
  // many parts went through, and that retrying the same OutboundMessage
  // will duplicate them.
  // let requires justification: accumulates across sub-calls below
  let delivered = 0;
  const tryStep = async (step: () => Promise<unknown>): Promise<void> => {
    try {
      await step();
      delivered++;
    } catch (err: unknown) {
      if (delivered === 0) throw err;
      throw new TelegramPartialDeliveryError(delivered, err);
    }
  };

  // Walk blocks in original order, batching contiguous text + buttons
  // into a single sendMessage group; flushing at every media boundary
  // and at the end so the chat order matches the caller's intent.
  // let requires justification: accumulates text for the current sendMessage group
  let pendingText = "";
  let pendingButtons: {
    readonly label: string;
    readonly action: string;
    readonly payload?: unknown;
  }[] = [];

  const flushPending = async (): Promise<void> => {
    if (pendingText.length === 0 && pendingButtons.length === 0) return;
    const keyboard: TelegramReplyMarkup | undefined =
      pendingButtons.length > 0
        ? {
            inline_keyboard: [
              pendingButtons.map((b) => ({
                text: b.label,
                callback_data: encodeCallbackData(b.action, b.payload),
              })),
            ],
          }
        : undefined;
    // Telegram rejects sendMessage with empty `text`. Button-only
    // groups synthesize a single non-empty character.
    const chunks = pendingText.length > 0 ? splitText(pendingText, TEXT_LIMIT) : [" "];
    for (let i = 0; i < chunks.length; i++) {
      const text = chunks[i] ?? "";
      const isLast = i === chunks.length - 1;
      const other: {
        -readonly [K in keyof TelegramSendMessageOther]: TelegramSendMessageOther[K];
      } = {};
      if (threadId !== undefined) other.message_thread_id = threadId;
      if (isLast && keyboard !== undefined) other.reply_markup = keyboard;
      const hasOther = Object.keys(other).length > 0;
      await tryStep(() =>
        callWith429Retry(() =>
          hasOther ? api.sendMessage(chatId, text, other) : api.sendMessage(chatId, text),
        ),
      );
    }
    pendingText = "";
    pendingButtons = [];
  };

  for (const b of message.content) {
    switch (b.kind) {
      case "text":
        pendingText = pendingText.length > 0 ? `${pendingText}\n${b.text}` : b.text;
        break;
      case "button":
        pendingButtons.push(
          b.payload !== undefined
            ? { label: b.label, action: b.action, payload: b.payload }
            : { label: b.label, action: b.action },
        );
        break;
      case "image": {
        await flushPending();
        const other = photoOther(b.alt);
        await tryStep(() =>
          callWith429Retry(() =>
            other === undefined
              ? api.sendPhoto(chatId, b.url)
              : api.sendPhoto(chatId, b.url, other),
          ),
        );
        break;
      }
      case "file": {
        await flushPending();
        const other = docOther();
        await tryStep(() =>
          callWith429Retry(() =>
            other === undefined
              ? api.sendDocument(chatId, b.url)
              : api.sendDocument(chatId, b.url, other),
          ),
        );
        break;
      }
      case "custom":
        // Custom blocks are skipped — telegram has no generic escape hatch.
        break;
    }
  }
  await flushPending();
}

/**
 * Thrown when a multi-part Telegram send fails after at least one part
 * has already been delivered. Retry/queue middleware should detect this
 * error class and NOT blindly retry the same `OutboundMessage` — doing
 * so would duplicate the already-delivered parts in the chat. Surface
 * it to the caller so they can either accept partial delivery or
 * compose a manual recovery (e.g. send only the missing chunks).
 */
export class TelegramPartialDeliveryError extends Error {
  readonly deliveredParts: number;
  override readonly cause: unknown;
  constructor(deliveredParts: number, cause: unknown) {
    super(
      `[channel-telegram] partial delivery: ${deliveredParts} part(s) sent before failure; retrying the same OutboundMessage will duplicate them`,
    );
    this.name = "TelegramPartialDeliveryError";
    this.deliveredParts = deliveredParts;
    this.cause = cause;
  }
}

/** Bot API callback_data limit: 64 bytes (UTF-8) per Telegram docs. */
const TELEGRAM_CALLBACK_DATA_LIMIT = 64;

function encodeCallbackData(action: string, payload: unknown): string {
  const encoded = payload === undefined ? action : `${action}:${JSON.stringify(payload)}`;
  // Fail closed: Telegram rejects sendMessage entirely when any callback_data
  // exceeds the limit, so a normal-looking response with a too-large payload
  // would silently drop the whole message (and any preceding media we already
  // sent in the same logical reply). Throw clearly instead.
  const byteLen = new TextEncoder().encode(encoded).length;
  if (byteLen > TELEGRAM_CALLBACK_DATA_LIMIT) {
    throw new Error(
      `[channel-telegram] button callback_data exceeds ${TELEGRAM_CALLBACK_DATA_LIMIT}-byte limit (got ${byteLen} bytes for action "${action}"). Store the payload behind an opaque token instead.`,
    );
  }
  return encoded;
}

function parseThreadId(threadId: string): {
  readonly chatId: number;
  readonly threadId?: number;
} {
  const parts = threadId.split(":");
  const chatId = Number(parts[0]);
  if (!Number.isFinite(chatId)) {
    throw new Error(`[channel-telegram] invalid threadId "${threadId}"`);
  }
  if (parts.length < 2) return { chatId };
  // Fail closed: a malformed forum-topic suffix (anything non-numeric) must
  // not silently route to the parent chat, or thread-isolated replies could
  // leak into the broader group.
  const sub = Number(parts[1]);
  if (!Number.isFinite(sub)) {
    throw new Error(`[channel-telegram] invalid forum-topic suffix in threadId "${threadId}"`);
  }
  return { chatId, threadId: sub };
}

interface TelegramApiError {
  readonly error_code?: number;
  readonly parameters?: { readonly retry_after?: number };
}

function isTelegramRateLimit(err: unknown): err is TelegramApiError {
  if (typeof err !== "object" || err === null) return false;
  const e = err as TelegramApiError;
  return e.error_code === 429;
}

/**
 * Maximum seconds to honour a Telegram `retry_after` value. The Bot API
 * occasionally returns very large `retry_after` (minutes to hours), and
 * because send() calls are serialized in this adapter, blindly sleeping
 * would wedge every subsequent send and prevent disconnect/restart for
 * that whole window. Cap at 60s and surface a retryable error past it
 * so operators (or middleware) can back off explicitly.
 */
const TELEGRAM_429_MAX_WAIT_SECONDS = 60;

async function callWith429Retry<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err: unknown) {
    if (!isTelegramRateLimit(err)) throw err;
    const requested = err.parameters?.retry_after ?? 1;
    if (requested > TELEGRAM_429_MAX_WAIT_SECONDS) {
      throw new Error(
        `[channel-telegram] 429 retry_after=${requested}s exceeds adapter cap (${TELEGRAM_429_MAX_WAIT_SECONDS}s) — refusing to block the send pipeline; retry later`,
        { cause: err },
      );
    }
    await new Promise((r) => setTimeout(r, requested * 1000));
    return await fn();
  }
}

async function instantiateBot(token: string): Promise<TelegramBotLike> {
  const mod = (await import("grammy")) as unknown as {
    readonly Bot: new (token: string) => TelegramBotLike;
  };
  return new mod.Bot(token);
}
