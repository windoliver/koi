/**
 * Public arg parser API — aggregates all per-command modules.
 *
 * External consumers (`bin.ts`, `types.ts`, `registry.ts`, command stubs)
 * import from here. Per-command modules can also be imported directly
 * if only one flag type is needed.
 */

export type { DeployFlags } from "./deploy.js";
export { isDeployFlags, parseDeployFlags } from "./deploy.js";
export type { DoctorFlags } from "./doctor.js";
export { isDoctorFlags, parseDoctorFlags } from "./doctor.js";
export type { InitFlags } from "./init.js";
export { isInitFlags, parseInitFlags } from "./init.js";
export type { LogsFlags } from "./logs.js";
export { isLogsFlags, parseLogsFlags } from "./logs.js";
export type { McpFlags, McpSubcommand } from "./mcp.js";
export { isMcpFlags, parseMcpFlags } from "./mcp.js";
export type { PluginFlags, PluginSubcommand } from "./plugin.js";
export { isPluginFlags, parsePluginFlags } from "./plugin.js";
export type { ServeFlags } from "./serve.js";
export { isServeFlags, parseServeFlags } from "./serve.js";
export type { SessionsFlags } from "./sessions.js";
export { isSessionsFlags, parseSessionsFlags } from "./sessions.js";
export type { BaseFlags, GlobalFlags } from "./shared.js";
export { detectGlobalFlags, extractCommand, ParseError } from "./shared.js";
export type { StartFlags, StartMode } from "./start.js";
export { isStartFlags, parseStartFlags } from "./start.js";
export type { StatusFlags } from "./status.js";
export { isStatusFlags, parseStatusFlags } from "./status.js";
export type { StopFlags } from "./stop.js";
export { isStopFlags, parseStopFlags } from "./stop.js";
export type { TuiFlags } from "./tui.js";
export { isTuiFlags, parseTuiFlags } from "./tui.js";

// ---------------------------------------------------------------------------
// CliFlags union — the superset type used at the dispatch boundary
// ---------------------------------------------------------------------------

import type { DeployFlags } from "./deploy.js";
import { parseDeployFlags } from "./deploy.js";
import type { DoctorFlags } from "./doctor.js";
import { parseDoctorFlags } from "./doctor.js";
import type { InitFlags } from "./init.js";
import { parseInitFlags } from "./init.js";
import type { LogsFlags } from "./logs.js";
import { parseLogsFlags } from "./logs.js";
import type { McpFlags } from "./mcp.js";
import { parseMcpFlags } from "./mcp.js";
import type { PluginFlags } from "./plugin.js";
import { parsePluginFlags } from "./plugin.js";
import type { ServeFlags } from "./serve.js";
import { parseServeFlags } from "./serve.js";
import type { SessionsFlags } from "./sessions.js";
import { parseSessionsFlags } from "./sessions.js";
import type { BaseFlags } from "./shared.js";
import { detectGlobalFlags, extractCommand } from "./shared.js";
import type { StartFlags } from "./start.js";
import { parseStartFlags } from "./start.js";
import type { StatusFlags } from "./status.js";
import { parseStatusFlags } from "./status.js";
import type { StopFlags } from "./stop.js";
import { parseStopFlags } from "./stop.js";
import type { TuiFlags } from "./tui.js";
import { parseTuiFlags } from "./tui.js";

export type CliFlags =
  | InitFlags
  | StartFlags
  | ServeFlags
  | TuiFlags
  | SessionsFlags
  | LogsFlags
  | StatusFlags
  | DoctorFlags
  | StopFlags
  | DeployFlags
  | McpFlags
  | PluginFlags
  | BaseFlags;

// ---------------------------------------------------------------------------
// Command registry
// ---------------------------------------------------------------------------

export type KnownCommand =
  | "init"
  | "start"
  | "serve"
  | "tui"
  | "sessions"
  | "logs"
  | "status"
  | "doctor"
  | "stop"
  | "deploy"
  | "mcp"
  | "plugin";

const KNOWN_COMMANDS: ReadonlyArray<KnownCommand> = [
  "init",
  "start",
  "serve",
  "tui",
  "sessions",
  "logs",
  "status",
  "doctor",
  "stop",
  "deploy",
  "mcp",
  "plugin",
];

export const COMMAND_NAMES: ReadonlyArray<KnownCommand> = KNOWN_COMMANDS;

export function isKnownCommand(cmd: string | undefined): cmd is KnownCommand {
  if (cmd === undefined) return false;
  for (const name of COMMAND_NAMES) {
    if (name === cmd) return true;
  }
  return false;
}

type CommandParser = (rest: readonly string[]) => CliFlags;

const COMMAND_PARSERS: Readonly<Record<KnownCommand, CommandParser>> = {
  init: parseInitFlags,
  start: parseStartFlags,
  serve: parseServeFlags,
  tui: parseTuiFlags,
  sessions: parseSessionsFlags,
  logs: parseLogsFlags,
  status: parseStatusFlags,
  doctor: parseDoctorFlags,
  stop: parseStopFlags,
  deploy: parseDeployFlags,
  mcp: parseMcpFlags,
  plugin: parsePluginFlags,
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function parseArgs(argv: readonly string[]): CliFlags {
  const globalFlags = detectGlobalFlags(argv);
  const { command, rest } = extractCommand(argv);

  // Known commands own their own --help/-h/--version/-V parsing. node:util
  // handles option-value arity (so e.g. `koi start --prompt --help` treats
  // `--help` as the string value of `--prompt`, not as a help request).
  // Pass `rest` through intact — no pre-filtering, no GlobalFlags merge:
  // the per-command parser is authoritative for its own argv.
  if (isKnownCommand(command)) {
    return COMMAND_PARSERS[command](rest);
  }

  // Unknown command — fall back to the bare globalFlags shape so callers
  // like `bin.ts` can still surface top-level --help/--version/--unknown
  // without loading a command module.
  return { command, ...globalFlags };
}
