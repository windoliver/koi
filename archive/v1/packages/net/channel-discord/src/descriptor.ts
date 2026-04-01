/**
 * BrickDescriptor for @koi/channel-discord.
 *
 * Enables manifest auto-resolution for the Discord bot channel.
 * Token is read from context.env.DISCORD_BOT_TOKEN.
 * Application ID is read from context.env.DISCORD_APPLICATION_ID.
 */

import type { ChannelAdapter } from "@koi/core";
import type { BrickDescriptor, ResolutionContext } from "@koi/resolve";
import { validateOptionalDescriptorOptions } from "@koi/resolve";
import type { DiscordFeatures } from "./config.js";
import { createDiscordChannel } from "./discord-channel.js";

function parseFeatures(options: Readonly<Record<string, unknown>>): DiscordFeatures | undefined {
  const features = options.features;
  if (features === undefined || typeof features !== "object" || features === null) {
    return undefined;
  }
  const f = features as Readonly<Record<string, unknown>>;
  return {
    ...(typeof f.text === "boolean" ? { text: f.text } : {}),
    ...(typeof f.voice === "boolean" ? { voice: f.voice } : {}),
    ...(typeof f.reactions === "boolean" ? { reactions: f.reactions } : {}),
    ...(typeof f.threads === "boolean" ? { threads: f.threads } : {}),
    ...(typeof f.slashCommands === "boolean" ? { slashCommands: f.slashCommands } : {}),
  };
}

/**
 * Descriptor for Discord channel adapter.
 * Exported for registration with createRegistry().
 */
export const descriptor: BrickDescriptor<ChannelAdapter> = {
  kind: "channel",
  name: "@koi/channel-discord",
  aliases: ["discord"],
  optionsValidator: (input) => validateOptionalDescriptorOptions(input, "Discord channel"),
  factory(options, context: ResolutionContext): ChannelAdapter {
    const token = context.env.DISCORD_BOT_TOKEN;
    if (token === undefined || token === "") {
      throw new Error(
        "Missing DISCORD_BOT_TOKEN environment variable. " + "Set it to use the Discord channel.",
      );
    }

    const opts = options as Readonly<Record<string, unknown>>;
    const applicationId = context.env.DISCORD_APPLICATION_ID;
    const features = parseFeatures(opts);

    return createDiscordChannel({
      token,
      ...(applicationId !== undefined && applicationId !== "" ? { applicationId } : {}),
      ...(features !== undefined ? { features } : {}),
    });
  },
};
