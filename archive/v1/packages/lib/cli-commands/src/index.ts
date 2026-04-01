/**
 * @koi/cli-commands — Slash commands, dispatch, and tab completion for CLI REPL channels.
 *
 * Layer: L0u (utility — pure functions, no business logic).
 *
 * Provides 10 slash commands for mid-conversation use in the channel-cli REPL:
 * /help, /clear, /cancel, /quit, /model, /status, /attach, /sessions, /tools, /forge
 */

export { CLI_COMMANDS } from "./commands.js";
export {
  type CompletionCache,
  createCompletionCache,
  refreshCache,
  slashCompleter,
} from "./completer.js";
export { handleSlashCommand, TUI_ONLY_COMMANDS } from "./dispatch.js";
export type {
  CliAgentSummary,
  CliCommandDeps,
  CliCommandDepsBase,
  CliSessionSummary,
  CliToolSummary,
  CommandResult,
  ForgeSearchResult,
  SlashCommand,
} from "./types.js";
