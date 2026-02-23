/**
 * Telegram → InboundMessage normalizer.
 *
 * Maps grammY Context objects to InboundMessage, or returns null for
 * platform system events that should not trigger agent turns.
 *
 * threadId convention: String(ctx.chat.id) — the ChannelAdapter threadId
 * acts as the Telegram chat_id for routing outbound messages. For outbound
 * messages, OutboundMessage.threadId must be set to this value.
 *
 * Media file URLs: photo, document, audio, voice, and video blocks resolve
 * real download URLs via ctx.api.getFile() (async Telegram API call).
 * The resulting URL format is:
 *   https://api.telegram.org/file/bot{token}/{file_path}
 * These URLs are valid for ~1 hour. If the agent needs to re-fetch later,
 * it should call getFile again via a tool.
 *
 * Callback queries: ctx.answerCallbackQuery() is called immediately to clear
 * Telegram's loading spinner on the button. If it rejects, the error is logged
 * and the InboundMessage is still returned — the agent response is more
 * important than the acknowledgment.
 */

import type { MessageNormalizer } from "@koi/channel-base";
import { button, custom, file, image, text } from "@koi/channel-base";
import type { InboundMessage } from "@koi/core";
import type { Api, Context } from "grammy";

/**
 * Resolves a Telegram file_id to a download URL using the bot token.
 * Falls back to a tg:// scheme reference if file_path is unavailable.
 */
async function resolveFileUrl(api: Api, token: string, fileId: string): Promise<string> {
  const fileInfo = await api.getFile(fileId);
  if (fileInfo.file_path !== undefined) {
    return `https://api.telegram.org/file/bot${token}/${fileInfo.file_path}`;
  }
  // Fallback — file not available for download (e.g., file too large)
  return `tg://file/${fileId}`;
}

/**
 * Creates an async MessageNormalizer<Context> that maps Telegram updates
 * to InboundMessage blocks.
 *
 * @param token - The bot token, used to construct media download URLs.
 * @returns An async normalizer for use with createChannelAdapter<Context>().
 */
export function createNormalizer(token: string): MessageNormalizer<Context> {
  return async (ctx: Context): Promise<InboundMessage | null> => {
    const chatId = ctx.chat?.id;
    const fromId = ctx.from?.id;

    if (chatId === undefined || fromId === undefined) {
      // Channel posts (no from), inline queries (no chat), etc.
      return null;
    }

    const senderId = String(fromId);
    const threadId = String(chatId);
    const timestamp = Date.now();

    // --- Callback query (button press) ---
    if (ctx.callbackQuery !== undefined) {
      try {
        await ctx.answerCallbackQuery();
      } catch (e: unknown) {
        // Do not propagate — always deliver the InboundMessage.
        // The agent's response matters more than the ack spinner.
        console.error("[channel-telegram] answerCallbackQuery failed:", e);
      }

      const data = ctx.callbackQuery.data ?? "";
      const colonIdx = data.indexOf(":");
      let action: string;
      let payload: unknown;

      if (colonIdx === -1) {
        action = data;
        payload = undefined;
      } else {
        action = data.slice(0, colonIdx);
        const payloadStr = data.slice(colonIdx + 1);
        try {
          payload = JSON.parse(payloadStr) as unknown;
        } catch {
          // Non-JSON payload — treat as raw string
          payload = payloadStr;
        }
      }

      const block =
        payload !== undefined ? button(action, action, payload) : button(action, action);
      return { content: [block], senderId, threadId, timestamp };
    }

    // --- Regular message ---
    const msg = ctx.message;
    if (msg === undefined) {
      // edited_message, channel_post, chat_member, my_chat_member, etc.
      return null;
    }

    // Text
    if (msg.text !== undefined) {
      return { content: [text(msg.text)], senderId, threadId, timestamp };
    }

    // Photo — take highest resolution variant
    if (msg.photo !== undefined && msg.photo.length > 0) {
      const highest = msg.photo[msg.photo.length - 1];
      if (highest !== undefined) {
        const url = await resolveFileUrl(ctx.api, token, highest.file_id);
        const altText = msg.caption;
        return {
          content: [image(url, altText)],
          senderId,
          threadId,
          timestamp,
        };
      }
    }

    // Document
    if (msg.document !== undefined) {
      const doc = msg.document;
      const url = await resolveFileUrl(ctx.api, token, doc.file_id);
      return {
        content: [file(url, doc.mime_type ?? "application/octet-stream", doc.file_name)],
        senderId,
        threadId,
        timestamp,
      };
    }

    // Audio
    if (msg.audio !== undefined) {
      const audio = msg.audio;
      const url = await resolveFileUrl(ctx.api, token, audio.file_id);
      return {
        content: [file(url, audio.mime_type ?? "audio/mpeg", audio.file_name)],
        senderId,
        threadId,
        timestamp,
      };
    }

    // Voice note
    if (msg.voice !== undefined) {
      const voice = msg.voice;
      const url = await resolveFileUrl(ctx.api, token, voice.file_id);
      return {
        content: [file(url, voice.mime_type ?? "audio/ogg")],
        senderId,
        threadId,
        timestamp,
      };
    }

    // Video
    if (msg.video !== undefined) {
      const video = msg.video;
      const url = await resolveFileUrl(ctx.api, token, video.file_id);
      return {
        content: [file(url, video.mime_type ?? "video/mp4")],
        senderId,
        threadId,
        timestamp,
      };
    }

    // Sticker — no standard ContentBlock type; pass as custom
    if (msg.sticker !== undefined) {
      return {
        content: [
          custom("telegram:sticker", {
            fileId: msg.sticker.file_id,
            emoji: msg.sticker.emoji,
            isAnimated: msg.sticker.is_animated,
          }),
        ],
        senderId,
        threadId,
        timestamp,
      };
    }

    // All other message types (location, contact, poll, etc.) → ignore
    return null;
  };
}
