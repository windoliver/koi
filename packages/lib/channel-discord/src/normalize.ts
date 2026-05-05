/**
 * Discord event → InboundMessage normalization.
 *
 * Tagged-union dispatch: messageCreate and interactionCreate are the two
 * platform events we accept. Bot's own messages are dropped.
 */

import type { ContentBlock, InboundMessage } from "@koi/core";

export interface DiscordAuthor {
  readonly id: string;
  readonly bot: boolean;
}

export interface DiscordAttachment {
  readonly url: string;
  readonly name: string | null;
  readonly contentType: string | null;
}

export interface DiscordMessageLike {
  readonly id: string;
  readonly content: string;
  readonly author: DiscordAuthor;
  readonly channelId: string;
  readonly guildId: string | null;
  readonly createdTimestamp: number;
  readonly attachments: ReadonlyMap<string, DiscordAttachment>;
  readonly isThread?: boolean;
}

export interface DiscordSlashCommandOption {
  readonly name: string;
  readonly value: string | number | boolean | null;
}

export interface DiscordSlashCommandLike {
  readonly kind: "slash_command";
  readonly id: string;
  readonly name: string;
  readonly options: readonly DiscordSlashCommandOption[];
  readonly userId: string;
  readonly channelId: string;
  readonly guildId: string | null;
  readonly createdTimestamp: number;
}

export interface DiscordButtonInteractionLike {
  readonly kind: "button";
  readonly id: string;
  readonly customId: string;
  readonly userId: string;
  readonly channelId: string;
  readonly guildId: string | null;
  readonly createdTimestamp: number;
}

export type DiscordEvent =
  | { readonly kind: "message"; readonly message: DiscordMessageLike }
  | { readonly kind: "slash_command"; readonly command: DiscordSlashCommandLike }
  | { readonly kind: "button"; readonly button: DiscordButtonInteractionLike };

/** Builds a normalizer that filters out the bot's own messages by user id. */
export function createNormalizer(
  getBotUserId: () => string | undefined,
): (event: DiscordEvent) => InboundMessage | null {
  return (event: DiscordEvent): InboundMessage | null => {
    switch (event.kind) {
      case "message":
        return normalizeMessage(event.message, getBotUserId());
      case "slash_command":
        return normalizeSlashCommand(event.command);
      case "button":
        return normalizeButton(event.button);
    }
  };
}

function normalizeMessage(
  message: DiscordMessageLike,
  botUserId: string | undefined,
): InboundMessage | null {
  if (message.author.bot && message.author.id === botUserId) return null;

  const blocks: ContentBlock[] = [];
  if (message.content.length > 0) {
    blocks.push({ kind: "text", text: message.content });
  }
  for (const [, att] of message.attachments) {
    const ct = att.contentType ?? "application/octet-stream";
    if (ct.startsWith("image/")) {
      blocks.push({ kind: "image", url: att.url, ...(att.name ? { alt: att.name } : {}) });
    } else {
      blocks.push({
        kind: "file",
        url: att.url,
        mimeType: ct,
        ...(att.name ? { name: att.name } : {}),
      });
    }
  }
  if (blocks.length === 0) return null;

  return {
    content: blocks,
    senderId: message.author.id,
    threadId: resolveThreadId(message),
    timestamp: message.createdTimestamp,
  };
}

function normalizeSlashCommand(cmd: DiscordSlashCommandLike): InboundMessage {
  const block: ContentBlock = {
    kind: "custom",
    type: "discord:slash_command",
    data: { name: cmd.name, options: cmd.options.map((o) => ({ name: o.name, value: o.value })) },
  };
  return {
    content: [block],
    senderId: cmd.userId,
    threadId: resolveThreadIdFromIds(cmd.guildId, cmd.channelId, cmd.userId),
    timestamp: cmd.createdTimestamp,
  };
}

function normalizeButton(btn: DiscordButtonInteractionLike): InboundMessage {
  const [action, payloadJson] = splitCustomId(btn.customId);
  const payload = payloadJson === undefined ? undefined : safeParse(payloadJson);
  const block: ContentBlock = {
    kind: "button",
    label: action,
    action,
    ...(payload !== undefined ? { payload } : {}),
  };
  return {
    content: [block],
    senderId: btn.userId,
    threadId: resolveThreadIdFromIds(btn.guildId, btn.channelId, btn.userId),
    timestamp: btn.createdTimestamp,
  };
}

function resolveThreadId(message: DiscordMessageLike): string {
  return resolveThreadIdFromIds(message.guildId, message.channelId, message.author.id);
}

function resolveThreadIdFromIds(guildId: string | null, channelId: string, userId: string): string {
  if (guildId === null) return `dm:${userId}`;
  return `${guildId}:${channelId}`;
}

function splitCustomId(customId: string): readonly [string, string | undefined] {
  const idx = customId.indexOf(":");
  if (idx < 0) return [customId, undefined];
  return [customId.slice(0, idx), customId.slice(idx + 1)];
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}
