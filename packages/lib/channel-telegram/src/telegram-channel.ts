/**
 * @koi/channel-telegram — grammy ChannelAdapter factory.
 *
 * Polling and webhook deployments. Polling drives a long-running update
 * loop; webhook exposes `handleUpdate(update)` so the caller's HTTPS
 * handler can forward updates without owning the bot's transport.
 */

import { createChannelAdapter } from "@koi/channel-base";
import type { ChannelAdapter, ChannelCapabilities, ContentBlock, OutboundMessage } from "@koi/core";
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
  ) => void;
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
  // platformConnect) and onPlatformEvent installing updateHandler. Without
  // this, the first updates of a polling session would be silently
  // dropped. Bounded — old entries roll off under sustained traffic.
  const PENDING_BUFFER_MAX = 256;
  // let requires justification: drained when updateHandler is installed.
  let pending: TelegramUpdateLike[] = [];
  // Webhook dedupe ring. Telegram retries a webhook delivery on any
  // ambiguous response (timeout, 5xx, network blip), so the same
  // update_id can land more than once. Without this guard each retry
  // would re-run the same agent turn and any attached tool side effects.
  // The ring holds the last N update_ids — adequate because Telegram
  // only retries the most recent undelivered update, not arbitrarily
  // old ones.
  const WEBHOOK_DEDUPE_RING_SIZE = 1024;
  const seenUpdateIds = new Set<number>();
  const seenUpdateOrder: number[] = [];
  const isDuplicateUpdate = (id: number): boolean => {
    if (seenUpdateIds.has(id)) return true;
    seenUpdateIds.add(id);
    seenUpdateOrder.push(id);
    if (seenUpdateOrder.length > WEBHOOK_DEDUPE_RING_SIZE) {
      const evicted = seenUpdateOrder.shift();
      if (evicted !== undefined) seenUpdateIds.delete(evicted);
    }
    return false;
  };

  const deliver = (update: TelegramUpdateLike): void => {
    if (updateHandler !== undefined) {
      updateHandler(update);
      return;
    }
    pending.push(update);
    if (pending.length > PENDING_BUFFER_MAX) {
      pending = pending.slice(-PENDING_BUFFER_MAX);
    }
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
      }
      // Connect-time handshake: validate the bot token by calling getMe.
      await bot.api.getMe();
      connected = true;
      if (deployment.mode === "polling") {
        const b = bot;
        // Register the dispatcher middleware BEFORE start() — grammY drains
        // the polling loop through registered middleware. `deliver` buffers
        // updates that arrive before onPlatformEvent installs updateHandler.
        b.use(async (ctx, next): Promise<void> => {
          deliver(ctx.update);
          await next();
        });
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
          // a half-initialized bot into the rest of the lifecycle.
          bot = undefined;
          throw new Error(
            `[channel-telegram] bot.start() rejected during connect: ${String(result.rejected)}`,
            { cause: result.rejected },
          );
        }
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
      }
    },

    platformDisconnect: async (): Promise<void> => {
      connected = false;
      if (bot === undefined) return;
      if (deployment.mode === "polling") {
        await bot.stop();
      }
      updateHandler = undefined;
      pending = [];
      bot = undefined;
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

  adapter = {
    ...base,
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
    handleWebhook: (secretHeaderValue, update): void => {
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
      // Replay protection: Telegram retries webhook delivery on
      // timeouts/5xx/network blips, so the same update_id can land
      // more than once. Drop duplicates BEFORE dispatch so an
      // already-processed agent turn does not re-fire its tool calls.
      if (isDuplicateUpdate(update.update_id)) return;
      // Use the same buffered delivery path as polling so updates that
      // arrive between connect() and onPlatformEvent's handler install
      // are not silently dropped.
      deliver(update);
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

  const parts = partitionContent(message.content);

  // Validate the entire outbound plan BEFORE the first side-effecting API
  // call. Photos and documents are non-revertible — if a later button payload
  // turned out to exceed Telegram's 64-byte callback_data cap, the user would
  // see an orphaned media attachment with no explanatory text. Encoding now
  // throws synchronously and aborts the whole send before any media leaves.
  const keyboard: TelegramReplyMarkup | undefined =
    parts.buttons.length > 0
      ? {
          inline_keyboard: [
            parts.buttons.map((b) => ({
              text: b.label,
              callback_data: encodeCallbackData(b.action, b.payload),
            })),
          ],
        }
      : undefined;

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
  // will duplicate them. The wrapper class lets retry/queue middleware
  // recognise and skip blind retries.
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

  // Photos: one API call each
  for (const photo of parts.images) {
    const other = photoOther(photo.alt);
    await tryStep(() =>
      callWith429Retry(() =>
        other === undefined
          ? api.sendPhoto(chatId, photo.url)
          : api.sendPhoto(chatId, photo.url, other),
      ),
    );
  }

  // Documents: one API call each
  for (const doc of parts.files) {
    const other = docOther();
    await tryStep(() =>
      callWith429Retry(() =>
        other === undefined
          ? api.sendDocument(chatId, doc.url)
          : api.sendDocument(chatId, doc.url, other),
      ),
    );
  }

  // Text + inline keyboard: one or more sendMessage calls.
  if (parts.text.length > 0 || parts.buttons.length > 0) {
    // Telegram rejects sendMessage with empty `text`. When the caller wants a
    // button-only response (no text blocks), synthesize a single non-empty
    // character so the API accepts the call. Single space is the smallest
    // payload that survives Telegram's whitespace trim.
    const chunks = parts.text.length > 0 ? splitText(parts.text, TEXT_LIMIT) : [" "];
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
  }
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

interface PartitionedContent {
  readonly text: string;
  readonly images: readonly { readonly url: string; readonly alt?: string }[];
  readonly files: readonly { readonly url: string }[];
  readonly buttons: readonly {
    readonly label: string;
    readonly action: string;
    readonly payload?: unknown;
  }[];
}

function partitionContent(blocks: readonly ContentBlock[]): PartitionedContent {
  const images: { readonly url: string; readonly alt?: string }[] = [];
  const files: { readonly url: string }[] = [];
  const buttons: { readonly label: string; readonly action: string; readonly payload?: unknown }[] =
    [];
  // let requires justification: accumulator for joined text content
  let text = "";
  for (const b of blocks) {
    switch (b.kind) {
      case "text":
        text = text.length > 0 ? `${text}\n${b.text}` : b.text;
        break;
      case "image":
        images.push(b.alt !== undefined ? { url: b.url, alt: b.alt } : { url: b.url });
        break;
      case "file":
        files.push({ url: b.url });
        break;
      case "button":
        buttons.push(
          b.payload !== undefined
            ? { label: b.label, action: b.action, payload: b.payload }
            : { label: b.label, action: b.action },
        );
        break;
      case "custom":
        // Custom blocks are skipped — telegram has no generic escape hatch.
        break;
    }
  }
  return { text, images, files, buttons };
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
