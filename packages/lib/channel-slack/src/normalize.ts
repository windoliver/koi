/**
 * Slack event → InboundMessage normalizer.
 *
 * Tagged union of supported Slack events, with per-event normalization.
 * Bot self-filtering, file attachment handling, slash command + block action
 * surfacing as InboundMessage.
 */

import type { ContentBlock, InboundMessage } from "@koi/core";

export interface SlackFileObject {
  readonly id: string;
  readonly name?: string;
  readonly mimetype?: string;
  readonly url_private?: string;
}

export interface SlackMessageEvent {
  readonly type: string;
  readonly subtype?: string;
  readonly text?: string;
  readonly user?: string;
  readonly bot_id?: string;
  readonly channel: string;
  readonly ts: string;
  readonly thread_ts?: string;
  readonly files?: readonly SlackFileObject[];
}

export interface SlackAppMentionEvent {
  readonly type: string;
  readonly text?: string;
  readonly user: string;
  readonly channel: string;
  readonly ts: string;
  readonly thread_ts?: string;
}

export interface SlackSlashCommand {
  readonly command: string;
  readonly text: string;
  readonly user_id: string;
  readonly channel_id: string;
  readonly trigger_id: string;
  readonly response_url: string;
}

export interface SlackBlockAction {
  readonly type: string;
  readonly action_id: string;
  readonly block_id: string;
  readonly value?: string;
  readonly user: { readonly id: string };
  readonly channel?: { readonly id: string };
  readonly message?: { readonly ts: string; readonly thread_ts?: string };
}

export type SlackEvent =
  | { readonly kind: "message"; readonly event: SlackMessageEvent }
  | { readonly kind: "app_mention"; readonly event: SlackAppMentionEvent }
  | { readonly kind: "slash_command"; readonly command: SlackSlashCommand }
  | { readonly kind: "block_action"; readonly action: SlackBlockAction };

export function resolveThreadId(channel: string, threadTs?: string): string {
  return threadTs !== undefined ? `${channel}:${threadTs}` : channel;
}

function fileBlock(f: SlackFileObject): ContentBlock | null {
  if (f.url_private === undefined) return null;
  const mimeType = f.mimetype ?? "application/octet-stream";
  if (mimeType.startsWith("image/")) {
    return f.name !== undefined
      ? { kind: "image", url: f.url_private, alt: f.name }
      : { kind: "image", url: f.url_private };
  }
  return f.name !== undefined
    ? { kind: "file", url: f.url_private, mimeType, name: f.name }
    : { kind: "file", url: f.url_private, mimeType };
}

function normalizeMessage(event: SlackMessageEvent, botUserId: string): InboundMessage | null {
  if (event.user === botUserId) return null;
  if (
    event.subtype !== undefined &&
    event.subtype !== "file_share" &&
    event.subtype !== "thread_broadcast"
  ) {
    return null;
  }
  const blocks: ContentBlock[] = [];
  if (event.text !== undefined && event.text.length > 0) {
    blocks.push({ kind: "text", text: event.text });
  }
  if (event.files !== undefined) {
    for (const f of event.files) {
      const b = fileBlock(f);
      if (b !== null) blocks.push(b);
    }
  }
  if (blocks.length === 0) return null;
  return {
    content: blocks,
    senderId: event.user ?? "unknown",
    threadId: resolveThreadId(event.channel, event.thread_ts),
    timestamp: Math.floor(Number(event.ts) * 1000),
  };
}

function normalizeSlashCommand(cmd: SlackSlashCommand): InboundMessage {
  return {
    content: [
      {
        kind: "custom",
        type: "slack:slash_command",
        data: {
          command: cmd.command,
          text: cmd.text,
          triggerId: cmd.trigger_id,
          responseUrl: cmd.response_url,
        },
      },
    ],
    senderId: cmd.user_id,
    threadId: cmd.channel_id,
    timestamp: Date.now(),
  };
}

function normalizeBlockAction(a: SlackBlockAction): InboundMessage {
  return {
    content: [
      {
        kind: "custom",
        type: "slack:block_action",
        data: {
          actionId: a.action_id,
          blockId: a.block_id,
          value: a.value,
        },
      },
    ],
    senderId: a.user.id,
    threadId:
      a.channel !== undefined ? resolveThreadId(a.channel.id, a.message?.thread_ts) : "unknown",
    timestamp: Date.now(),
  };
}

/**
 * Top-level dispatcher: `SlackEvent → InboundMessage` (or null to drop).
 *
 * `botUserId` accepts either the raw string OR a getter `() => string` so the
 * caller can resolve the ID asynchronously (e.g. via Slack `auth.test` during
 * connect) without rebuilding the normalizer. The getter form is what
 * `createSlackChannel` uses to ensure self-message filtering works from the
 * first event after connect, even when `botUserId` was not provided in config.
 */
export function createNormalizer(
  botUserId: string | (() => string),
): (event: SlackEvent) => InboundMessage | null {
  const getId = typeof botUserId === "function" ? botUserId : (): string => botUserId;
  return (event) => {
    const id = getId();
    switch (event.kind) {
      case "message":
        return normalizeMessage(event.event, id);
      case "app_mention":
        return normalizeMessage({ ...event.event, type: "message" }, id);
      case "slash_command":
        return normalizeSlashCommand(event.command);
      case "block_action":
        return normalizeBlockAction(event.action);
    }
  };
}
