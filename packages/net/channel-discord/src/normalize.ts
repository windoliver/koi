/**
 * Thin composer dispatching to per-event-type normalizers.
 *
 * This module is the entry point for all Discord event normalization.
 * It dispatches to the correct normalizer based on the event wrapper type.
 */

import type { MessageNormalizer } from "@koi/channel-base";
import type { InboundMessage } from "@koi/core";
import { normalizeInteraction } from "./normalize-interaction.js";
import { normalizeMessage } from "./normalize-message.js";
import { normalizeReaction } from "./normalize-reaction.js";
import { normalizeVoiceState } from "./normalize-voice.js";

/**
 * A tagged union for Discord events that the channel adapter listens to.
 * The `kind` field is set by the event listener in the factory.
 */
export type DiscordEvent =
  | { readonly kind: "message"; readonly message: import("discord.js").Message }
  | { readonly kind: "interaction"; readonly interaction: import("discord.js").Interaction }
  | {
      readonly kind: "voiceStateUpdate";
      readonly oldState: import("discord.js").VoiceState;
      readonly newState: import("discord.js").VoiceState;
    }
  | {
      readonly kind: "reactionAdd";
      readonly reaction:
        | import("discord.js").MessageReaction
        | import("discord.js").PartialMessageReaction;
      readonly user: import("discord.js").User | import("discord.js").PartialUser;
    }
  | {
      readonly kind: "reactionRemove";
      readonly reaction:
        | import("discord.js").MessageReaction
        | import("discord.js").PartialMessageReaction;
      readonly user: import("discord.js").User | import("discord.js").PartialUser;
    };

/**
 * Creates a normalizer that dispatches Discord events to the correct handler.
 *
 * @param botUserId - The bot's own user ID, used to filter self-messages.
 * @returns A MessageNormalizer for DiscordEvent.
 */
export function createNormalizer(botUserId: string): MessageNormalizer<DiscordEvent> {
  return async (event: DiscordEvent): Promise<InboundMessage | null> => {
    switch (event.kind) {
      case "message":
        return normalizeMessage(event.message, botUserId);
      case "interaction":
        return normalizeInteraction(event.interaction);
      case "voiceStateUpdate":
        return normalizeVoiceState(event.oldState, event.newState, botUserId);
      case "reactionAdd":
        return normalizeReaction(event.reaction, event.user, "add", botUserId);
      case "reactionRemove":
        return normalizeReaction(event.reaction, event.user, "remove", botUserId);
    }
  };
}
