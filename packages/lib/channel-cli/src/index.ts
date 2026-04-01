/**
 * @koi/channel-cli — CLI channel adapter for stdin/stdout terminal I/O.
 */

export type {
  CliChannelConfig,
  CliTheme,
  SlashCommandHandler,
  SlashCommandResult,
  SlashCompleter,
} from "./cli-channel.js";
export { createCliChannel } from "./cli-channel.js";
