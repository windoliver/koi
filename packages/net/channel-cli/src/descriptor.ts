/**
 * BrickDescriptor for @koi/channel-cli.
 *
 * Enables manifest auto-resolution for the CLI stdin/stdout channel.
 * Supports `options.theme` from koi.yaml:
 *
 *   channels:
 *     - name: cli
 *       options:
 *         theme: dark
 */

import type { ChannelAdapter } from "@koi/core";
import type { BrickDescriptor, JsonObject } from "@koi/resolve";
import { validateOptionalDescriptorOptions } from "@koi/resolve";
import type { CliTheme } from "./cli-channel.js";
import { createCliChannel } from "./cli-channel.js";

const VALID_THEMES = new Set(["default", "mono", "dark", "light"]);

/**
 * Descriptor for CLI channel adapter.
 * Exported for registration with createRegistry().
 */
export const descriptor: BrickDescriptor<ChannelAdapter> = {
  kind: "channel",
  name: "@koi/channel-cli",
  aliases: ["cli"],
  optionsValidator: (input) => validateOptionalDescriptorOptions(input, "CLI channel"),
  factory(options: JsonObject): ChannelAdapter {
    const opts = options as Readonly<Record<string, unknown>>;
    const rawTheme = opts.theme;
    const theme: CliTheme | undefined =
      typeof rawTheme === "string" && VALID_THEMES.has(rawTheme)
        ? (rawTheme as CliTheme)
        : undefined;
    const rawPrompt = opts.prompt;
    const prompt = typeof rawPrompt === "string" ? rawPrompt : undefined;

    return createCliChannel({
      ...(theme !== undefined ? { theme } : {}),
      ...(prompt !== undefined ? { prompt } : {}),
    });
  },
};
