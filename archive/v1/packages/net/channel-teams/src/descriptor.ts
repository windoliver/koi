/**
 * BrickDescriptor for @koi/channel-teams.
 *
 * Enables manifest auto-resolution for the Teams channel.
 * Reads appId, appPassword, and tenantId from environment.
 */

import type { ChannelAdapter } from "@koi/core";
import type { BrickDescriptor, ResolutionContext } from "@koi/resolve";
import { validateOptionalDescriptorOptions } from "@koi/resolve";
import { createTeamsChannel } from "./teams-channel.js";

/**
 * Descriptor for Teams channel adapter.
 * Exported for registration with createRegistry().
 */
export const descriptor: BrickDescriptor<ChannelAdapter> = {
  kind: "channel",
  name: "@koi/channel-teams",
  aliases: ["teams"],
  optionsValidator: (input) => validateOptionalDescriptorOptions(input, "Teams channel"),
  factory(_options, context: ResolutionContext): ChannelAdapter {
    const appId = context.env.TEAMS_APP_ID;
    const appPassword = context.env.TEAMS_APP_PASSWORD;

    if (appId === undefined || appId === "") {
      throw new Error(
        "Missing TEAMS_APP_ID environment variable. Set it to use the Teams channel.",
      );
    }
    if (appPassword === undefined || appPassword === "") {
      throw new Error(
        "Missing TEAMS_APP_PASSWORD environment variable. Set it to use the Teams channel.",
      );
    }

    const tenantId = context.env.TEAMS_TENANT_ID;
    return createTeamsChannel({
      appId,
      appPassword,
      ...(tenantId !== undefined && tenantId !== "" ? { tenantId } : {}),
    });
  },
};
