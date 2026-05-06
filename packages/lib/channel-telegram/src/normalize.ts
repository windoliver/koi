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

export interface TelegramAudioLike {
  readonly file_id: string;
  readonly file_name?: string;
  readonly mime_type?: string;
  readonly duration?: number;
}

export interface TelegramVideoLike {
  readonly file_id: string;
  readonly file_name?: string;
  readonly mime_type?: string;
  readonly duration?: number;
}

export interface TelegramVoiceLike {
  readonly file_id: string;
  readonly mime_type?: string;
  readonly duration?: number;
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
  readonly audio?: TelegramAudioLike;
  readonly video?: TelegramVideoLike;
  readonly voice?: TelegramVoiceLike;
  readonly message_thread_id?: number;
}

export interface TelegramCallbackQueryLike {
  readonly id: string;
  readonly from: TelegramUserLike;
  readonly data?: string;
  readonly message?: TelegramMessageLike;
  /**
   * Set when the callback fires from an inline-mode result (no chat
   * context). The adapter cannot reply via sendMessage — it would have to
   * use editMessageText with inline_message_id, which is out of scope.
   */
  readonly inline_message_id?: string;
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
    // let requires justification: result enriched with metadata.updateId below
    let normalized: InboundMessage | null;
    if (update.callback_query !== undefined) {
      normalized = await normalizeCallbackQuery(update.callback_query, deps);
    } else if (update.message !== undefined) {
      normalized = await normalizeMessage(update.message, deps);
    } else {
      return null;
    }
    if (normalized === null) return null;
    // Surface update_id so dedupe layers (HTTPS handler, durable queue)
    // have a stable retry key even after normalization strips the outer
    // wrapper. Telegram retries reuse update_id verbatim.
    return {
      ...normalized,
      metadata: { ...(normalized.metadata ?? {}), updateId: update.update_id },
    };
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

  // Routing rules — fail closed on every ambiguous shape:
  //  - Inline-mode (`inline_message_id`): emit non-repliable `inline:<id>`
  //  - Chat-bound: derive thread from `message.chat.id` (+ optional topic)
  //  - Neither present: emit non-repliable `inline:cq:<id>` to refuse send
  //
  // The previous fallback to `cq.from.id` looked benign (the user's id IS
  // their DM chat id) but silently rerouted *group-originated* callbacks
  // into the clicking user's private chat whenever Telegram delivered no
  // `message` payload — leaking workflow replies and breaking auditability.
  // let requires justification: branchy threadId derivation
  let threadId: string;
  if (cq.inline_message_id !== undefined) {
    threadId = `inline:${cq.inline_message_id}`;
  } else if (cq.message !== undefined) {
    const chatId = cq.message.chat.id;
    const threadIdFromMsg = cq.message.message_thread_id;
    threadId = threadIdFromMsg === undefined ? String(chatId) : `${chatId}:${threadIdFromMsg}`;
  } else {
    threadId = `inline:cq:${cq.id}`;
  }

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

  // Media messages: emit a media block, and — when the user attached a
  // caption — emit a sibling text block so the caption (often the actual
  // user prompt: "summarize this", "translate") reaches the agent
  // alongside the attachment instead of being lost or buried in `alt`.
  // let requires justification: blocks accumulated across media branches
  const blocks: ContentBlock[] = [];

  if (msg.photo !== undefined && msg.photo.length > 0) {
    const highest = msg.photo[msg.photo.length - 1];
    if (highest === undefined) return null;
    const url = await deps.getFileUrl(highest.file_id);
    const image: ContentBlock = {
      kind: "image",
      url,
      ...(msg.caption !== undefined ? { alt: msg.caption } : {}),
    };
    blocks.push(image);
  } else if (msg.document !== undefined) {
    const url = await deps.getFileUrl(msg.document.file_id);
    blocks.push({
      kind: "file",
      url,
      mimeType: msg.document.mime_type ?? "application/octet-stream",
      ...(msg.document.file_name !== undefined ? { name: msg.document.file_name } : {}),
    });
  } else if (msg.audio !== undefined) {
    const url = await deps.getFileUrl(msg.audio.file_id);
    blocks.push({
      kind: "file",
      url,
      mimeType: msg.audio.mime_type ?? "audio/mpeg",
      ...(msg.audio.file_name !== undefined ? { name: msg.audio.file_name } : {}),
    });
  } else if (msg.video !== undefined) {
    const url = await deps.getFileUrl(msg.video.file_id);
    blocks.push({
      kind: "file",
      url,
      mimeType: msg.video.mime_type ?? "video/mp4",
      ...(msg.video.file_name !== undefined ? { name: msg.video.file_name } : {}),
    });
  } else if (msg.voice !== undefined) {
    const url = await deps.getFileUrl(msg.voice.file_id);
    blocks.push({
      kind: "file",
      url,
      mimeType: msg.voice.mime_type ?? "audio/ogg",
    });
  }

  if (blocks.length === 0) return null;

  if (msg.caption !== undefined) {
    blocks.push({ kind: "text", text: msg.caption });
  }

  return { content: blocks, senderId, threadId, timestamp };
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}
