/**
 * OutboundMessage → Telegram API sender.
 *
 * Maps Koi ContentBlocks to Telegram Bot API calls. One API call per block,
 * with adjacent TextBlocks merged into a single sendMessage call.
 *
 * threadId convention: OutboundMessage.threadId is required and is used as
 * the Telegram chat_id. Throws if threadId is missing.
 *
 * Text splitting: Telegram's sendMessage limit is 4096 characters. Longer
 * text blocks are split at 4096-char boundaries and sent as separate messages.
 *
 * Button encoding: ButtonBlock.action + optional JSON payload are encoded into
 * Telegram's callback_data field (64-byte limit). action:JSON.stringify(payload)
 * is used when payload is present. If the combined string exceeds 64 bytes,
 * only action is used and a warning is logged.
 *
 * Rate limiting: on Telegram 429 (Too Many Requests), the sender waits
 * retry_after seconds (from the error parameters) and retries once.
 *
 * CustomBlock: no capability flag in ChannelCapabilities — renderBlocks()
 * passes custom blocks through unchanged. They are silently ignored here
 * since we have no platform mapping for unknown custom types.
 */

import type { ContentBlock, OutboundMessage } from "@koi/core";
import type { Bot } from "grammy";
import { GrammyError, InlineKeyboard } from "grammy";

/** Telegram sendMessage character limit. */
const TEXT_LIMIT = 4096;

/** Telegram callback_data byte limit. */
const CALLBACK_DATA_LIMIT = 64;

/** Maximum send attempts for rate-limited (429) requests. */
const MAX_RETRIES = 3;

/** Valid Telegram parse_mode values. */
type ParseMode = "HTML" | "MarkdownV2" | "Markdown";

function isParseMode(v: string): v is ParseMode {
  return v === "HTML" || v === "MarkdownV2" || v === "Markdown";
}

/**
 * Splits a threadId into Telegram chat_id and optional message_thread_id.
 * Format: "chatId" or "chatId:messageThreadId"
 */
function parseChatTarget(threadId: string): {
  readonly chatId: string;
  readonly messageThreadId?: number;
} {
  const idx = threadId.indexOf(":");
  if (idx === -1) {
    return { chatId: threadId };
  }
  return {
    chatId: threadId.slice(0, idx),
    messageThreadId: Number(threadId.slice(idx + 1)),
  };
}

// ---------------------------------------------------------------------------
// Internal chunk types — output of buildChunks
// ---------------------------------------------------------------------------

type TextChunk = { readonly kind: "text"; readonly text: string };
type MediaChunk = { readonly kind: "media"; readonly block: ContentBlock };
type SendChunk = TextChunk | MediaChunk;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Sends an OutboundMessage to Telegram.
 *
 * @param bot - The grammY Bot instance.
 * @param message - The message to send. threadId (chat_id) is required.
 * @throws {Error} If threadId is missing.
 * @throws {GrammyError} For non-retryable Telegram API errors.
 */
export async function telegramSend(bot: Bot, message: OutboundMessage): Promise<void> {
  if (message.threadId === undefined) {
    throw new Error(
      "[channel-telegram] Cannot send: OutboundMessage.threadId (chatId) is required. " +
        "Ensure the agent echoes the threadId from the InboundMessage.",
    );
  }

  const { chatId, messageThreadId } = parseChatTarget(message.threadId);

  // Extract parse_mode from metadata if provided (Telegram-specific, stays in metadata)
  const rawParseMode: unknown = message.metadata?.parse_mode;
  const parseMode: ParseMode | undefined =
    typeof rawParseMode === "string" && isParseMode(rawParseMode) ? rawParseMode : undefined;

  const chunks = buildChunks(message);

  for (const chunk of chunks) {
    await sendWithRetry(bot, chatId, messageThreadId, parseMode, chunk);
  }
}

// ---------------------------------------------------------------------------
// Chunk builder — merges adjacent text blocks
// ---------------------------------------------------------------------------

function buildChunks(message: OutboundMessage): readonly SendChunk[] {
  const chunks: SendChunk[] = [];
  // let requires justification: accumulates adjacent text blocks for merging
  let pendingText = "";

  for (const block of message.content) {
    if (block.kind === "text") {
      pendingText = pendingText.length > 0 ? `${pendingText}\n${block.text}` : block.text;
    } else {
      if (pendingText.length > 0) {
        chunks.push({ kind: "text", text: pendingText });
        pendingText = "";
      }
      if (block.kind !== "custom") {
        // Custom blocks have no Telegram mapping — silently skip
        chunks.push({ kind: "media", block });
      }
    }
  }

  if (pendingText.length > 0) {
    chunks.push({ kind: "text", text: pendingText });
  }

  return chunks;
}

// ---------------------------------------------------------------------------
// Retry wrapper — handles Telegram 429
// ---------------------------------------------------------------------------

async function sendWithRetry(
  bot: Bot,
  chatId: string,
  messageThreadId: number | undefined,
  parseMode: ParseMode | undefined,
  chunk: SendChunk,
): Promise<void> {
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      await sendChunk(bot, chatId, messageThreadId, parseMode, chunk);
      return;
    } catch (e: unknown) {
      if (e instanceof GrammyError && e.error_code === 429 && attempt < MAX_RETRIES - 1) {
        // GrammyError.parameters is typed as Record<string,unknown> by grammy;
        // extract retry_after safely without a banned as-assertion.
        const params: unknown = e.parameters;
        const retryAfter =
          typeof params === "object" &&
          params !== null &&
          "retry_after" in params &&
          typeof (params as Record<string, unknown>).retry_after === "number"
            ? ((params as Record<string, unknown>).retry_after as number)
            : 1;
        await sleep(retryAfter * 1000);
      } else {
        throw e;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Per-chunk sender
// ---------------------------------------------------------------------------

async function sendChunk(
  bot: Bot,
  chatId: string,
  messageThreadId: number | undefined,
  parseMode: ParseMode | undefined,
  chunk: SendChunk,
): Promise<void> {
  // Conditional spreads — exactOptionalPropertyTypes: omit when undefined
  const threadOpt = messageThreadId !== undefined ? { message_thread_id: messageThreadId } : {};
  const modeOpt = parseMode !== undefined ? { parse_mode: parseMode } : {};

  if (chunk.kind === "text") {
    const parts = splitText(chunk.text);
    for (const part of parts) {
      await bot.api.sendMessage(chatId, part, { ...threadOpt, ...modeOpt });
    }
    return;
  }

  const block = chunk.block;

  switch (block.kind) {
    case "image":
      await bot.api.sendPhoto(chatId, block.url, {
        ...(block.alt !== undefined && { caption: block.alt }),
        ...threadOpt,
        ...modeOpt,
      });
      break;

    case "file":
      await bot.api.sendDocument(chatId, block.url, {
        ...(block.name !== undefined && { caption: block.name }),
        ...threadOpt,
        ...modeOpt,
      });
      break;

    case "button": {
      const callbackData = encodeCallbackData(block.action, block.payload);
      const keyboard = new InlineKeyboard().text(block.label, callbackData);
      await bot.api.sendMessage(chatId, block.label, {
        reply_markup: keyboard,
        ...threadOpt,
        ...modeOpt,
      });
      break;
    }

    case "text":
    case "custom":
      // text: handled above in the "text" chunk branch
      // custom: no Telegram mapping — filtered out in buildChunks
      break;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Splits text into chunks of at most TEXT_LIMIT characters.
 * Prefers splitting at newlines to avoid cutting mid-sentence.
 */
function splitText(inputText: string): readonly string[] {
  if (inputText.length <= TEXT_LIMIT) {
    return [inputText];
  }

  const parts: string[] = [];
  // let requires justification: cursor position advances through the remaining text
  let remaining = inputText;

  while (remaining.length > TEXT_LIMIT) {
    const slice = remaining.slice(0, TEXT_LIMIT);
    const lastNewline = slice.lastIndexOf("\n");
    const splitAt = lastNewline > 0 ? lastNewline + 1 : TEXT_LIMIT;
    parts.push(remaining.slice(0, splitAt).trimEnd());
    remaining = remaining.slice(splitAt).trimStart();
  }

  if (remaining.length > 0) {
    parts.push(remaining);
  }

  return parts;
}

/**
 * Encodes action + payload into a Telegram callback_data string (64-byte limit).
 *
 * Format: "action" or "action:JSON.stringify(payload)"
 * If the combined string exceeds 64 bytes, the payload is dropped and only
 * action is used (truncated to 64 bytes). This is a hard Telegram API constraint.
 * For rich payloads, embed data in the action string or use an in-memory store.
 */
function encodeCallbackData(action: string, payload: unknown): string {
  if (payload === undefined) {
    return truncateUtf8(action, CALLBACK_DATA_LIMIT);
  }

  const combined = `${action}:${JSON.stringify(payload)}`;
  if (byteLength(combined) <= CALLBACK_DATA_LIMIT) {
    return combined;
  }

  console.warn(
    `[channel-telegram] ButtonBlock callback_data exceeds ${CALLBACK_DATA_LIMIT} bytes. ` +
      `Payload dropped. action="${action}"`,
  );
  return truncateUtf8(action, CALLBACK_DATA_LIMIT);
}

// Module-level codec instances — avoid per-call allocations in button encoding.
const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder();

function byteLength(str: string): number {
  return utf8Encoder.encode(str).length;
}

/**
 * Truncates a string to fit within maxBytes (UTF-8 encoded).
 * Strips any trailing replacement character (U+FFFD) that arises when slicing
 * falls in the middle of a multi-byte sequence.
 */
function truncateUtf8(str: string, maxBytes: number): string {
  const encoded = utf8Encoder.encode(str);
  if (encoded.length <= maxBytes) {
    return str;
  }
  return utf8Decoder.decode(encoded.slice(0, maxBytes)).replace(/\uFFFD+$/, "");
}

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}
