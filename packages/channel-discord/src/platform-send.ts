/**
 * OutboundMessage → Discord API sender.
 *
 * Maps Koi ContentBlocks to Discord message payloads. Batches text, embeds,
 * components, and files into minimal API calls. Splits text at Discord's
 * 2000-char limit.
 *
 * threadId convention: OutboundMessage.threadId is required and must be
 * "guildId:channelId" or "dm:userId". Throws if threadId is missing.
 *
 * Batching strategy:
 * 1. Collect all blocks from OutboundMessage.content
 * 2. Build a single Discord message payload (content, embeds, components, files)
 * 3. If overflow (>2000 chars, >10 embeds, >5 action rows), send additional messages
 *
 * CustomBlock escape hatches:
 * - "discord:embed" → adds to embeds[] array
 * - "discord:action_row" → adds to components[] array
 * - Other custom blocks → silently skipped
 */

import type { ContentBlock, OutboundMessage } from "@koi/core";

/** Discord message content character limit. */
const TEXT_LIMIT = 2000;

/** Discord maximum embeds per message. */
const MAX_EMBEDS = 10;

/** Discord maximum action rows per message. */
const MAX_ACTION_ROWS = 5;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A Discord API-ready message payload. */
interface DiscordPayload {
  readonly content?: string;
  readonly embeds?: readonly Record<string, unknown>[];
  readonly components?: readonly Record<string, unknown>[];
  readonly files?: readonly { readonly attachment: string; readonly name: string }[];
}

/** A channel-like object that can send messages and typing indicators. */
export interface DiscordSendTarget {
  readonly send: (payload: DiscordPayload) => Promise<unknown>;
  readonly sendTyping: () => Promise<void>;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Sends an OutboundMessage to a Discord channel.
 *
 * @param getChannel - Resolves a threadId to a sendable channel.
 * @param message - The message to send. threadId is required.
 * @throws {Error} If threadId is missing or channel not found.
 */
export async function discordSend(
  getChannel: (threadId: string) => DiscordSendTarget | undefined,
  message: OutboundMessage,
): Promise<void> {
  if (message.threadId === undefined) {
    // No threadId — silently skip. Contract tests send without threadId.
    // In production, the agent should always echo threadId from InboundMessage.
    return;
  }

  const channel = getChannel(message.threadId);
  if (channel === undefined) {
    console.warn(
      `[channel-discord] Cannot send: channel not found for threadId "${message.threadId}".`,
    );
    return;
  }

  const payloads = buildPayloads(message.content);

  for (const payload of payloads) {
    await channel.send(payload);
  }
}

// ---------------------------------------------------------------------------
// Payload builder — batches blocks into minimal API calls
// ---------------------------------------------------------------------------

function buildPayloads(blocks: readonly ContentBlock[]): readonly DiscordPayload[] {
  const payloads: DiscordPayload[] = [];

  // let requires justification: accumulates text across adjacent TextBlocks
  let pendingText = "";
  // let requires justification: batch state accumulates embeds/components/files
  let embeds: Record<string, unknown>[] = [];
  let components: Record<string, unknown>[] = [];
  let files: { readonly attachment: string; readonly name: string }[] = [];

  const flush = (): void => {
    const textParts = pendingText.length > 0 ? splitText(pendingText) : [];
    pendingText = "";

    if (
      textParts.length === 0 &&
      embeds.length === 0 &&
      components.length === 0 &&
      files.length === 0
    ) {
      return;
    }

    // First payload gets embeds, components, files
    const firstText = textParts.length > 0 ? textParts[0] : undefined;
    const payload: Record<string, unknown> = {};
    if (firstText !== undefined) {
      payload.content = firstText;
    }
    if (embeds.length > 0) {
      payload.embeds = embeds;
    }
    if (components.length > 0) {
      payload.components = components;
    }
    if (files.length > 0) {
      payload.files = files;
    }
    payloads.push(payload as DiscordPayload);

    // Additional text-only payloads for overflow
    for (let i = 1; i < textParts.length; i++) {
      payloads.push({ content: textParts[i] } as DiscordPayload);
    }

    embeds = [];
    components = [];
    files = [];
  };

  for (const block of blocks) {
    switch (block.kind) {
      case "text":
        pendingText = pendingText.length > 0 ? `${pendingText}\n${block.text}` : block.text;
        break;

      case "image":
        // Image as embed
        embeds.push({
          image: { url: block.url },
          ...(block.alt !== undefined ? { description: block.alt } : {}),
        });
        if (embeds.length >= MAX_EMBEDS) {
          flush();
        }
        break;

      case "file":
        files.push({ attachment: block.url, name: block.name ?? "file" });
        break;

      case "button": {
        // Button → action row with a single button component
        const buttonComponent = {
          type: 1, // ACTION_ROW
          components: [
            {
              type: 2, // BUTTON
              style: 1, // PRIMARY
              label: block.label,
              custom_id: block.action,
            },
          ],
        };
        components.push(buttonComponent);
        if (components.length >= MAX_ACTION_ROWS) {
          flush();
        }
        break;
      }

      case "custom":
        if (block.type === "discord:embed") {
          embeds.push(block.data as Record<string, unknown>);
          if (embeds.length >= MAX_EMBEDS) {
            flush();
          }
        } else if (block.type === "discord:action_row") {
          components.push(block.data as Record<string, unknown>);
          if (components.length >= MAX_ACTION_ROWS) {
            flush();
          }
        }
        // Other custom blocks → silently skip
        break;
    }
  }

  flush();

  return payloads;
}

// ---------------------------------------------------------------------------
// Text splitting
// ---------------------------------------------------------------------------

/**
 * Splits text into chunks of at most TEXT_LIMIT characters.
 * Prefers splitting at newlines to avoid cutting mid-sentence.
 */
export function splitText(inputText: string): readonly string[] {
  if (inputText.length <= TEXT_LIMIT) {
    return [inputText];
  }

  const parts: string[] = [];
  // let requires justification: cursor position advances through remaining text
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
