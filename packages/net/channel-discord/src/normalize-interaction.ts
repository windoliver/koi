/**
 * Discord interactionCreate → InboundMessage normalizer.
 *
 * Handles slash commands, button clicks, and select menu interactions.
 * Auto-acknowledges interactions to prevent the 3-second timeout.
 */

import { button, custom, text } from "@koi/channel-base";
import type { InboundMessage } from "@koi/core";
import type { Interaction } from "discord.js";

/**
 * Normalizes a discord.js Interaction into an InboundMessage.
 *
 * @param interaction - The discord.js Interaction from interactionCreate event.
 * @returns InboundMessage or null if the interaction type is unhandled.
 */
export async function normalizeInteraction(
  interaction: Interaction,
): Promise<InboundMessage | null> {
  const senderId = interaction.user.id;
  const timestamp = interaction.createdTimestamp;
  const threadId = resolveInteractionThreadId(interaction);

  // Slash command
  if (interaction.isChatInputCommand()) {
    try {
      await interaction.deferReply();
    } catch (e: unknown) {
      console.error("[channel-discord] deferReply failed:", e);
    }

    const options: Record<string, unknown> = {};
    for (const opt of interaction.options.data) {
      options[opt.name] = opt.value;
    }

    return {
      content: [text(`/${interaction.commandName}`)],
      senderId,
      threadId,
      timestamp,
      metadata: {
        isSlashCommand: true,
        commandName: interaction.commandName,
        options,
      },
    };
  }

  // Button click
  if (interaction.isButton()) {
    try {
      await interaction.deferUpdate();
    } catch (e: unknown) {
      console.error("[channel-discord] deferUpdate failed:", e);
    }

    return {
      content: [button(interaction.customId, interaction.customId)],
      senderId,
      threadId,
      timestamp,
    };
  }

  // String select menu
  if (interaction.isStringSelectMenu()) {
    try {
      await interaction.deferUpdate();
    } catch (e: unknown) {
      console.error("[channel-discord] deferUpdate failed:", e);
    }

    return {
      content: [
        custom("discord:select_menu", {
          customId: interaction.customId,
          values: interaction.values,
        }),
      ],
      senderId,
      threadId,
      timestamp,
    };
  }

  // Unhandled interaction type
  return null;
}

/** Resolves threadId from an Interaction. */
function resolveInteractionThreadId(interaction: Interaction): string {
  const guildId = interaction.guildId;
  const channelId = interaction.channelId;

  if (guildId === null || channelId === null) {
    return `dm:${interaction.user.id}`;
  }

  return `${guildId}:${channelId}`;
}
