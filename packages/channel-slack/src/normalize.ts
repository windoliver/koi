/**
 * Slack event normalizer.
 *
 * Dispatches tagged SlackEvent union to per-type normalization functions.
 */

import type { MessageNormalizer } from "@koi/channel-base";
import type { InboundMessage } from "@koi/core";
import { normalizeInteraction } from "./normalize-interaction.js";
import { normalizeMessage } from "./normalize-message.js";

/** Slack raw message event shape (subset of Slack API). */
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

/** Slack file object shape (subset). */
export interface SlackFileObject {
  readonly id: string;
  readonly name?: string;
  readonly mimetype?: string;
  readonly url_private?: string;
  readonly filetype?: string;
}

/** Slack app_mention event shape. */
export interface SlackAppMentionEvent {
  readonly type: string;
  readonly text?: string;
  readonly user: string;
  readonly channel: string;
  readonly ts: string;
  readonly thread_ts?: string;
}

/** Slack slash command payload. */
export interface SlackSlashCommand {
  readonly command: string;
  readonly text: string;
  readonly user_id: string;
  readonly channel_id: string;
  readonly trigger_id: string;
  readonly response_url: string;
}

/** Slack block action payload. */
export interface SlackBlockAction {
  readonly type: string;
  readonly action_id: string;
  readonly block_id: string;
  readonly value?: string;
  readonly user: { readonly id: string };
  readonly channel?: { readonly id: string };
  readonly message?: { readonly ts: string; readonly thread_ts?: string };
}

/** Slack reaction event shape. */
export interface SlackReactionEvent {
  readonly type: string;
  readonly user: string;
  readonly reaction: string;
  readonly item: {
    readonly type: string;
    readonly channel: string;
    readonly ts: string;
  };
  readonly event_ts: string;
}

/** Tagged union of all supported Slack events. */
export type SlackEvent =
  | { readonly kind: "message"; readonly event: SlackMessageEvent }
  | { readonly kind: "app_mention"; readonly event: SlackAppMentionEvent }
  | { readonly kind: "slash_command"; readonly command: SlackSlashCommand }
  | { readonly kind: "block_action"; readonly action: SlackBlockAction }
  | { readonly kind: "reaction_added"; readonly event: SlackReactionEvent }
  | { readonly kind: "reaction_removed"; readonly event: SlackReactionEvent };

/**
 * Creates a normalizer function that dispatches SlackEvents to the
 * appropriate per-type handler.
 */
export function createNormalizer(botUserId: string): MessageNormalizer<SlackEvent> {
  return async (event: SlackEvent): Promise<InboundMessage | null> => {
    switch (event.kind) {
      case "message":
        return normalizeMessage(event.event, botUserId);
      case "app_mention":
        return normalizeMessage(
          { ...event.event, type: "message" } as SlackMessageEvent,
          botUserId,
        );
      case "slash_command":
        return normalizeInteraction(event);
      case "block_action":
        return normalizeInteraction(event);
      case "reaction_added":
      case "reaction_removed":
        return normalizeReaction(event);
    }
  };
}

function normalizeReaction(
  event:
    | { readonly kind: "reaction_added"; readonly event: SlackReactionEvent }
    | { readonly kind: "reaction_removed"; readonly event: SlackReactionEvent },
): InboundMessage {
  const action = event.kind === "reaction_added" ? "add" : "remove";
  return {
    content: [
      {
        kind: "custom",
        type: "slack:reaction",
        data: {
          action,
          reaction: event.event.reaction,
          itemType: event.event.item.type,
          itemChannel: event.event.item.channel,
          itemTs: event.event.item.ts,
        },
      },
    ],
    senderId: event.event.user,
    threadId: event.event.item.channel,
    timestamp: Math.floor(Number(event.event.event_ts) * 1000),
  };
}
