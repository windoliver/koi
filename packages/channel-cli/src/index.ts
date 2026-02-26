/**
 * @koi/channel-cli — CLI stdin/stdout channel adapter (Layer 2).
 *
 * Implements the ChannelAdapter contract from @koi/core for interactive
 * terminal sessions. Reads user input via readline, writes output to stdout.
 */

export type { CliChannelConfig } from "./cli-channel.js";
export { createCliChannel } from "./cli-channel.js";
export { descriptor } from "./descriptor.js";
