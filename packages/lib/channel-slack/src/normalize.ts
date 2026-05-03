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
  // Identity resolution preserves provenance:
  //   - human user → `event.user` (e.g. "U123")
  //   - bot/integration with no user → `bot:<bot_id>` so distinct
  //     bots remain distinguishable downstream
  //   - neither present → drop, do not synthesize a shared "unknown"
  //     principal that would collapse multiple actors into one
  // Downstream auth/audit/dedupe keyed on senderId would otherwise
  // make decisions on the wrong principal.
  const senderId = event.user ?? (event.bot_id !== undefined ? `bot:${event.bot_id}` : null);
  if (senderId === null) return null;
  return {
    content: blocks,
    senderId,
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

function normalizeBlockAction(a: SlackBlockAction): InboundMessage | null {
  // Modal/home-tab interactions can omit `channel` — they have no
  // routable reply target. Synthesizing `threadId: "unknown"` would
  // collapse unrelated interactions onto one fake conversation key
  // and any reply attempt would post to channel `"unknown"`. Drop
  // here; downstream handlers that need to react to non-channel
  // interactions should subscribe to a different surface.
  if (a.channel === undefined) return null;
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
    threadId: resolveThreadId(a.channel.id, a.message?.thread_ts),
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
