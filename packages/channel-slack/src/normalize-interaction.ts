/**
 * Slack interaction normalizer.
 *
 * Handles slash commands and block actions.
 */

import { button, text } from "@koi/channel-base";
import type { InboundMessage } from "@koi/core";
import type { SlackBlockAction, SlackEvent, SlackSlashCommand } from "./normalize.js";

/**
 * Normalizes a Slack interaction (slash command or block action)
 * into an InboundMessage.
 */
export function normalizeInteraction(
  event: Extract<SlackEvent, { readonly kind: "slash_command" | "block_action" }>,
): InboundMessage | null {
  switch (event.kind) {
    case "slash_command":
      return normalizeSlashCommand(event.command);
    case "block_action":
      return normalizeBlockAction(event.action);
  }
}

function normalizeSlashCommand(command: SlackSlashCommand): InboundMessage {
  const commandText =
    command.text.length > 0 ? `${command.command} ${command.text}` : command.command;

  return {
    content: [text(commandText)],
    senderId: command.user_id,
    threadId: command.channel_id,
    timestamp: Date.now(),
    metadata: {
      isSlashCommand: true,
      commandName: command.command,
      triggerId: command.trigger_id,
      responseUrl: command.response_url,
    },
  };
}

function normalizeBlockAction(action: SlackBlockAction): InboundMessage | null {
  const channelId = action.channel?.id;
  if (channelId === undefined) {
    return null;
  }

  return {
    content: [button(action.action_id, action.action_id, action.value)],
    senderId: action.user.id,
    threadId: channelId,
    timestamp: Date.now(),
  };
}
