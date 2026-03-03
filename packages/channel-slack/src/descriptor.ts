/**
 * BrickDescriptor for @koi/channel-slack.
 *
 * Enables manifest auto-resolution for the Slack bot channel.
 * Token is read from context.env.SLACK_BOT_TOKEN.
 * App token is read from context.env.SLACK_APP_TOKEN.
 */

import type { ChannelAdapter } from "@koi/core";
import type { BrickDescriptor, ResolutionContext } from "@koi/resolve";
import { validateOptionalDescriptorOptions } from "@koi/resolve";
import type { SlackDeployment, SlackFeatures } from "./config.js";
import { createSlackChannel } from "./slack-channel.js";

function parseDeployment(
  options: Readonly<Record<string, unknown>>,
  env: Readonly<Record<string, string | undefined>>,
): SlackDeployment {
  // HTTP mode if signingSecret is provided
  if (typeof options.signingSecret === "string") {
    return {
      mode: "http",
      signingSecret: options.signingSecret,
      ...(typeof options.port === "number" ? { port: options.port } : {}),
    };
  }

  // Socket mode (default)
  const appToken = env.SLACK_APP_TOKEN;
  if (appToken === undefined || appToken === "") {
    throw new Error(
      "Missing SLACK_APP_TOKEN environment variable. " +
        "Required for Socket Mode. Set signingSecret in options for HTTP mode.",
    );
  }
  return { mode: "socket", appToken };
}

function parseFeatures(options: Readonly<Record<string, unknown>>): SlackFeatures | undefined {
  const features = options.features;
  if (features === undefined || typeof features !== "object" || features === null) {
    return undefined;
  }
  const f = features as Readonly<Record<string, unknown>>;
  return {
    ...(typeof f.threads === "boolean" ? { threads: f.threads } : {}),
    ...(typeof f.slashCommands === "boolean" ? { slashCommands: f.slashCommands } : {}),
    ...(typeof f.reactions === "boolean" ? { reactions: f.reactions } : {}),
    ...(typeof f.files === "boolean" ? { files: f.files } : {}),
  };
}

/**
 * Descriptor for Slack channel adapter.
 * Exported for registration with createRegistry().
 */
export const descriptor: BrickDescriptor<ChannelAdapter> = {
  kind: "channel",
  name: "@koi/channel-slack",
  aliases: ["slack"],
  optionsValidator: (input) => validateOptionalDescriptorOptions(input, "Slack channel"),
  factory(options, context: ResolutionContext): ChannelAdapter {
    const botToken = context.env.SLACK_BOT_TOKEN;
    if (botToken === undefined || botToken === "") {
      throw new Error(
        "Missing SLACK_BOT_TOKEN environment variable. " + "Set it to use the Slack channel.",
      );
    }

    const opts = options as Readonly<Record<string, unknown>>;
    const deployment = parseDeployment(opts, context.env);
    const features = parseFeatures(opts);

    return createSlackChannel({
      botToken,
      deployment,
      ...(features !== undefined ? { features } : {}),
    });
  },
};
