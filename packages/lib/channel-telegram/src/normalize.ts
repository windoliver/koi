/**
 * Telegram event → InboundMessage normalization.
 *
 * Accepts a minimal `TelegramUpdateLike` shape (subset of grammy's `Update`)
 * so tests can construct fixtures without instantiating a real Bot. Photos
 * resolve a CDN URL via the injected `getFileUrl` callback; documents do
 * the same.
 */

import type { ContentBlock, InboundMessage } from "@koi/core";

export interface TelegramUserLike {
  readonly id: number;
}

export interface TelegramChatLike {
  readonly id: number;
}

export interface TelegramPhotoSizeLike {
  readonly file_id: string;
  readonly width: number;
  readonly height: number;
}

export interface TelegramDocumentLike {
  readonly file_id: string;
  readonly file_name?: string;
  readonly mime_type?: string;
}

export interface TelegramMessageLike {
  readonly message_id: number;
  readonly from?: TelegramUserLike;
  readonly chat: TelegramChatLike;
  readonly date: number;
  readonly text?: string;
  readonly caption?: string;
  readonly photo?: readonly TelegramPhotoSizeLike[];
  readonly document?: TelegramDocumentLike;
  readonly message_thread_id?: number;
}

export interface TelegramCallbackQueryLike {
  readonly id: string;
  readonly from: TelegramUserLike;
  readonly data?: string;
  readonly message?: TelegramMessageLike;
}

export interface TelegramUpdateLike {
  readonly update_id: number;
  readonly message?: TelegramMessageLike;
  readonly callback_query?: TelegramCallbackQueryLike;
}

/** Resolves a Telegram `file_id` to a downloadable URL. */
export type GetFileUrl = (fileId: string) => Promise<string>;

/** Acknowledges a callback_query (clears the spinner on the user's button). */
export type AnswerCallbackQuery = (id: string) => Promise<void>;

export interface TelegramNormalizerDeps {
  readonly getFileUrl: GetFileUrl;
  readonly answerCallbackQuery: AnswerCallbackQuery;
  readonly onAckError?: (err: unknown) => void;
}

export function createNormalizer(
  deps: TelegramNormalizerDeps,
): (update: TelegramUpdateLike) => Promise<InboundMessage | null> {
  return async (update: TelegramUpdateLike): Promise<InboundMessage | null> => {
    if (update.callback_query !== undefined) {
      return normalizeCallbackQuery(update.callback_query, deps);
    }
    if (update.message !== undefined) {
      return normalizeMessage(update.message, deps);
    }
    return null;
  };
}

async function normalizeCallbackQuery(
  cq: TelegramCallbackQueryLike,
  deps: TelegramNormalizerDeps,
): Promise<InboundMessage | null> {
  try {
    await deps.answerCallbackQuery(cq.id);
  } catch (err: unknown) {
    deps.onAckError?.(err);
  }

  const data = cq.data ?? "";
  const idx = data.indexOf(":");
  const action = idx === -1 ? data : data.slice(0, idx);
  const payloadStr = idx === -1 ? undefined : data.slice(idx + 1);
  const payload = payloadStr === undefined ? undefined : safeParse(payloadStr);

  // Outbound `parseThreadId` expects a numeric chatId (optionally
  // ":threadId"). For Telegram a private-chat user id IS the chat id, so
  // we always emit a numeric-string form — never `dm:<id>` — so that
  // `send()` can reply on the same thread without a routing mismatch.
  const chatId = cq.message?.chat.id ?? cq.from.id;
  const threadIdFromMsg = cq.message?.message_thread_id;
  const threadId = threadIdFromMsg === undefined ? String(chatId) : `${chatId}:${threadIdFromMsg}`;

  const block: ContentBlock = {
    kind: "button",
    label: action,
    action,
    ...(payload !== undefined ? { payload } : {}),
  };
  return {
    content: [block],
    senderId: String(cq.from.id),
    threadId,
    timestamp: Date.now(),
  };
}

async function normalizeMessage(
  msg: TelegramMessageLike,
  deps: TelegramNormalizerDeps,
): Promise<InboundMessage | null> {
  if (msg.from === undefined) return null;

  const threadId =
    msg.message_thread_id === undefined
      ? String(msg.chat.id)
      : `${msg.chat.id}:${msg.message_thread_id}`;

  const senderId = String(msg.from.id);
  const timestamp = msg.date * 1000;

  if (msg.text !== undefined) {
    return {
      content: [{ kind: "text", text: msg.text }],
      senderId,
      threadId,
      timestamp,
    };
  }

  if (msg.photo !== undefined && msg.photo.length > 0) {
    const highest = msg.photo[msg.photo.length - 1];
    if (highest === undefined) return null;
    const url = await deps.getFileUrl(highest.file_id);
    const block: ContentBlock = {
      kind: "image",
      url,
      ...(msg.caption !== undefined ? { alt: msg.caption } : {}),
    };
    return { content: [block], senderId, threadId, timestamp };
  }

  if (msg.document !== undefined) {
    const url = await deps.getFileUrl(msg.document.file_id);
    const block: ContentBlock = {
      kind: "file",
      url,
      mimeType: msg.document.mime_type ?? "application/octet-stream",
      ...(msg.document.file_name !== undefined ? { name: msg.document.file_name } : {}),
    };
    return { content: [block], senderId, threadId, timestamp };
  }

  return null;
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}
