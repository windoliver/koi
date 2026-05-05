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

/** Bot-like surface required by the adapter. Subset of grammy's `Bot`. */
export interface TelegramBotLike {
  readonly api: TelegramApiLike;
  /** Register an update listener. Returns an unsubscribe function. */
  on(event: "update", handler: (update: TelegramUpdateLike) => void): () => void;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface TelegramSendOptions {
  readonly chat_id: number;
  readonly text?: string;
  readonly caption?: string;
  readonly message_thread_id?: number;
  readonly reply_markup?: TelegramReplyMarkup;
}

export interface TelegramReplyMarkup {
  readonly inline_keyboard: readonly (readonly TelegramInlineButton[])[];
}

export interface TelegramInlineButton {
  readonly text: string;
  readonly callback_data: string;
}

export interface TelegramApiLike {
  sendMessage(opts: TelegramSendOptions): Promise<unknown>;
  sendPhoto(opts: {
    readonly chat_id: number;
    readonly photo: string;
    readonly caption?: string;
    readonly message_thread_id?: number;
  }): Promise<unknown>;
  sendDocument(opts: {
    readonly chat_id: number;
    readonly document: string;
    readonly caption?: string;
    readonly message_thread_id?: number;
  }): Promise<unknown>;
  getFile(fileId: string): Promise<{ readonly file_path?: string }>;
  answerCallbackQuery(id: string): Promise<unknown>;
  /** Returns the bot's identity. Used as a connect-time handshake. */
  getMe(): Promise<{ readonly id: number; readonly username?: string }>;
}

export interface TelegramChannelConfig {
  readonly token: string;
  readonly deployment?: TelegramDeployment;
  /** Test-only injected bot double. */
  readonly bot?: TelegramBotLike;
  readonly onHandlerError?: (err: unknown, ctx: unknown) => void;
}

export interface TelegramChannelAdapter extends ChannelAdapter {
  /** Webhook mode only — caller forwards an HTTPS-delivered update. */
  readonly handleUpdate: (update: TelegramUpdateLike) => void;
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
  // let requires justification: bot is created lazily inside platformConnect
  let bot: TelegramBotLike | undefined = config.bot;
  // let requires justification: registered listener invoked by handleUpdate
  let updateHandler: ((update: TelegramUpdateLike) => void) | undefined;

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

  const base = createChannelAdapter<TelegramUpdateLike>({
    name: "telegram",
    capabilities: TELEGRAM_CAPABILITIES,

    platformConnect: async (): Promise<void> => {
      // Only instantiate the bot here. grammY's `start()` is the long-poll
      // loop and never resolves until `stop()` is called — awaiting it would
      // hang `connect()` forever and block listener registration.
      // Polling is kicked off from `onPlatformEvent` after the listener is
      // attached, so no updates are dropped between registration and first
      // poll.
      if (bot === undefined) {
        bot = await instantiateBot(config.token);
      }
      // Connect-time handshake: validate the bot token by calling getMe.
      // This surfaces auth errors and basic connectivity failures during
      // connect() instead of letting them disappear into the background
      // polling promise.
      await bot.api.getMe();
    },

    platformDisconnect: async (): Promise<void> => {
      if (bot === undefined) return;
      if (deployment.mode === "polling") {
        await bot.stop();
      }
      updateHandler = undefined;
      bot = undefined;
    },

    platformSend: async (message: OutboundMessage): Promise<void> => {
      await sendOutbound(requireBot().api, message);
    },

    onPlatformEvent: (handler): (() => void) => {
      const dispatch = (update: TelegramUpdateLike): void => {
        handler(update);
      };
      updateHandler = dispatch;
      if (deployment.mode === "polling") {
        const b = requireBot();
        const unsub = b.on("update", dispatch);
        // Attach the listener BEFORE polling starts so no update arrives
        // before there's a handler to receive it. Then drive the long-poll
        // loop in the background; surface fatal errors via onHandlerError.
        void b.start().catch((err: unknown) => {
          config.onHandlerError?.(err, { phase: "polling" });
        });
        return unsub;
      }
      return (): void => {
        updateHandler = undefined;
      };
    },

    normalize,
    ...(config.onHandlerError !== undefined && { onHandlerError: config.onHandlerError }),
  });

  return {
    ...base,
    handleUpdate: (update: TelegramUpdateLike): void => {
      updateHandler?.(update);
    },
    resolveMediaUrl,
  };
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

  // Photos: one API call each
  for (const photo of parts.images) {
    await callWith429Retry(() =>
      api.sendPhoto({
        chat_id: chatId,
        photo: photo.url,
        ...(photo.alt !== undefined ? { caption: photo.alt } : {}),
        ...(threadId !== undefined ? { message_thread_id: threadId } : {}),
      }),
    );
  }

  // Documents: one API call each
  for (const doc of parts.files) {
    await callWith429Retry(() =>
      api.sendDocument({
        chat_id: chatId,
        document: doc.url,
        ...(threadId !== undefined ? { message_thread_id: threadId } : {}),
      }),
    );
  }

  // Text + inline keyboard: one or more sendMessage calls.
  if (parts.text.length > 0 || parts.buttons.length > 0) {
    // Telegram rejects sendMessage with empty `text`. When the caller wants a
    // button-only response (no text blocks), synthesize a single non-empty
    // character so the API accepts the call. Single space is the smallest
    // payload that survives Telegram's whitespace trim.
    const chunks = parts.text.length > 0 ? splitText(parts.text, TEXT_LIMIT) : [" "];
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
    for (let i = 0; i < chunks.length; i++) {
      const text = chunks[i] ?? "";
      const isLast = i === chunks.length - 1;
      await callWith429Retry(() =>
        api.sendMessage({
          chat_id: chatId,
          text,
          ...(threadId !== undefined ? { message_thread_id: threadId } : {}),
          ...(isLast && keyboard !== undefined ? { reply_markup: keyboard } : {}),
        }),
      );
    }
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

async function callWith429Retry<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err: unknown) {
    if (!isTelegramRateLimit(err)) throw err;
    const wait = err.parameters?.retry_after ?? 1;
    await new Promise((r) => setTimeout(r, wait * 1000));
    return await fn();
  }
}

async function instantiateBot(token: string): Promise<TelegramBotLike> {
  const mod = (await import("grammy")) as unknown as {
    readonly Bot: new (token: string) => TelegramBotLike;
  };
  return new mod.Bot(token);
}
