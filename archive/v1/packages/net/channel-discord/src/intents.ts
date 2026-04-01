/**
 * Feature-driven Gateway intent computation.
 *
 * Maps DiscordFeatures flags to the required GatewayIntentBits.
 * Only requests what's needed — minimizes privileged intent usage.
 */

import { GatewayIntentBits } from "discord.js";
import type { DiscordFeatures } from "./config.js";

/** Resolves feature flags to defaults. */
function resolveFeatures(features?: DiscordFeatures): Required<DiscordFeatures> {
  return {
    text: features?.text ?? true,
    voice: features?.voice ?? false,
    reactions: features?.reactions ?? false,
    threads: features?.threads ?? true,
    slashCommands: features?.slashCommands ?? true,
  };
}

/**
 * Computes the minimal set of Gateway intents required for the given features.
 *
 * @param features - Feature flags from DiscordChannelConfig. Defaults applied internally.
 * @returns Deduplicated array of GatewayIntentBits values.
 */
export function computeIntents(features?: DiscordFeatures): readonly GatewayIntentBits[] {
  const resolved = resolveFeatures(features);
  const intents = new Set<GatewayIntentBits>();

  // Guilds is always required for basic guild context
  intents.add(GatewayIntentBits.Guilds);

  if (resolved.text) {
    intents.add(GatewayIntentBits.GuildMessages);
    intents.add(GatewayIntentBits.MessageContent); // Privileged intent
  }

  if (resolved.voice) {
    intents.add(GatewayIntentBits.GuildVoiceStates);
  }

  if (resolved.reactions) {
    intents.add(GatewayIntentBits.GuildMessageReactions);
  }

  // threads: included via Guilds intent (already added above)
  // slashCommands: no additional intents needed (interaction events are always sent)

  return [...intents];
}

export { resolveFeatures };
