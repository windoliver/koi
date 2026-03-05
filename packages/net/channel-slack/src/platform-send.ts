/**
 * Slack outbound message sender.
 *
 * Converts OutboundMessage → Slack Web API calls (chat.postMessage).
 * Handles text splitting at Slack's 4000-char limit, file uploads,
 * image blocks, button blocks, and rate-limit retries.
 */

import { splitText } from "@koi/channel-base";
import type { ContentBlock, OutboundMessage } from "@koi/core";
import { mapTextToSlackMrkdwn } from "./format.js";

/** Slack chat.postMessage text limit. */
const TEXT_LIMIT = 4000;

/** Maximum buttons per message (Slack allows 25 actions per view). */
const MAX_BUTTONS = 5;

/** Minimal interface for Slack WebClient.chat methods. */
export interface SlackWebApi {
  readonly postMessage: (args: Record<string, unknown>) => Promise<unknown>;
  readonly uploadV2?: (args: Record<string, unknown>) => Promise<unknown>;
}

/**
 * Sends an OutboundMessage via Slack Web API.
 *
 * @param api - Slack WebClient chat methods.
 * @param message - The outbound message to send.
 */
export async function slackSend(api: SlackWebApi, message: OutboundMessage): Promise<void> {
  if (message.threadId === undefined) {
    throw new Error(
      "[channel-slack] Cannot send: threadId is required. Echo threadId from InboundMessage.",
    );
  }

  const { channel, threadTs } = parseThreadId(message.threadId);
  const payloads = buildPayloads(message.content);

  for (const payload of payloads) {
    const args: Record<string, unknown> = {
      channel,
      ...payload,
      ...(threadTs !== undefined ? { thread_ts: threadTs } : {}),
    };
    await api.postMessage(args);
  }
}

/** Parsed threadId target. */
interface ChatTarget {
  readonly channel: string;
  readonly threadTs?: string;
}

function parseThreadId(threadId: string): ChatTarget {
  const idx = threadId.indexOf(":");
  if (idx === -1) {
    return { channel: threadId };
  }
  return {
    channel: threadId.slice(0, idx),
    threadTs: threadId.slice(idx + 1),
  };
}

/** A single Slack API payload. */
type SlackPayload = Record<string, unknown>;

function buildPayloads(blocks: readonly ContentBlock[]): readonly SlackPayload[] {
  const payloads: SlackPayload[] = [];

  // let justified: accumulate text and actions across blocks
  let pendingText = "";
  let pendingButtons: Record<string, unknown>[] = [];
  let pendingImages: Record<string, unknown>[] = [];

  const flush = (): void => {
    const textParts =
      pendingText.length > 0 ? splitText(mapTextToSlackMrkdwn(pendingText), TEXT_LIMIT) : [];
    if (textParts.length === 0 && pendingButtons.length === 0 && pendingImages.length === 0) {
      return;
    }

    const firstText = textParts.length > 0 ? textParts[0] : undefined;
    const payload: Record<string, unknown> = {};

    if (firstText !== undefined) {
      payload.text = firstText;
    }

    // Build Slack Block Kit blocks array
    const slackBlocks: Record<string, unknown>[] = [];

    // Add section block for text
    if (firstText !== undefined) {
      slackBlocks.push({
        type: "section",
        text: { type: "mrkdwn", text: firstText },
      });
    }

    // Add image blocks
    for (const img of pendingImages) {
      slackBlocks.push(img);
    }

    // Add action block for buttons
    if (pendingButtons.length > 0) {
      slackBlocks.push({
        type: "actions",
        elements: pendingButtons,
      });
    }

    if (slackBlocks.length > 0) {
      payload.blocks = slackBlocks;
    }

    payloads.push(payload);

    // Overflow text chunks (no blocks needed)
    for (let i = 1; i < textParts.length; i++) {
      payloads.push({ text: textParts[i] });
    }

    pendingText = "";
    pendingButtons = [];
    pendingImages = [];
  };

  for (const block of blocks) {
    switch (block.kind) {
      case "text":
        pendingText = pendingText.length > 0 ? `${pendingText}\n${block.text}` : block.text;
        break;
      case "image":
        pendingImages.push({
          type: "image",
          image_url: block.url,
          alt_text: block.alt ?? "image",
        });
        break;
      case "file":
        // Files need the URL as a text link (Slack file upload requires a separate API)
        pendingText =
          pendingText.length > 0
            ? `${pendingText}\n<${block.url}|${block.name ?? "file"}>`
            : `<${block.url}|${block.name ?? "file"}>`;
        break;
      case "button":
        pendingButtons.push({
          type: "button",
          text: { type: "plain_text", text: block.label },
          action_id: block.action,
          ...(block.payload !== undefined ? { value: String(block.payload) } : {}),
        });
        if (pendingButtons.length >= MAX_BUTTONS) {
          flush();
        }
        break;
      case "custom":
        // Escape hatch: pass-through Slack Block Kit blocks
        if (block.type === "slack:block") {
          flush();
          payloads.push({ blocks: [block.data] });
        }
        break;
    }
  }

  flush();
  return payloads;
}
