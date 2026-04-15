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
export { detectGlobalFlags, extractCommand, GLOBAL_RAW_FLAGS, ParseError } from "./shared.js";
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
import type { BaseFlags, GlobalFlags } from "./shared.js";
import { detectGlobalFlags, extractCommand, GLOBAL_RAW_FLAGS } from "./shared.js";
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

type CommandParser = (rest: readonly string[], g: GlobalFlags) => CliFlags;

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
  // Strip global flags (--help/-h/--version/-V) so per-command parsers
  // never see them as unknown options — but only before the `--` operand
  // terminator. Tokens after `--` are literal operands (e.g.
  // `koi plugin install -- --help` targets a plugin literally named
  // `--help`) and must reach the parser intact.
  const filteredRest = filterGlobalRawFlagsBeforeTerminator(rest);

  if (isKnownCommand(command)) {
    return COMMAND_PARSERS[command](filteredRest, globalFlags);
  }

  return { command, ...globalFlags };
}

function filterGlobalRawFlagsBeforeTerminator(argv: readonly string[]): readonly string[] {
  const out: string[] = [];
  let terminated = false;
  for (const a of argv) {
    if (terminated) {
      out.push(a);
      continue;
    }
    if (a === "--") {
      terminated = true;
      out.push(a);
      continue;
    }
    if (GLOBAL_RAW_FLAGS.has(a)) continue;
    out.push(a);
  }
  return out;
}
