/**
 * CLI argument parser — subcommand-aware design using node:util parseArgs.
 *
 * Extracts the command name first, then dispatches to command-specific
 * flag parsing via the command registry.
 */

import { parseArgs as nodeParseArgs } from "node:util";

// ---------------------------------------------------------------------------
// Flag types
// ---------------------------------------------------------------------------

export interface BaseFlags {
  readonly command: string | undefined;
  readonly directory: string | undefined;
  readonly version: boolean;
  readonly help: boolean;
}

export interface InitFlags extends BaseFlags {
  readonly command: "init";
  readonly yes: boolean;
  readonly name: string | undefined;
  readonly template: string | undefined;
  readonly model: string | undefined;
  readonly engine: string | undefined;
}

export interface StartFlags extends BaseFlags {
  readonly command: "start";
  readonly manifest: string | undefined;
  readonly verbose: boolean;
  readonly dryRun: boolean;
  readonly logFormat: "text" | "json";
}

export interface ServeFlags extends BaseFlags {
  readonly command: "serve";
  readonly manifest: string | undefined;
  readonly port: number | undefined;
  readonly verbose: boolean;
  readonly logFormat: "text" | "json";
}

export interface TuiFlags extends BaseFlags {
  readonly command: "tui";
  readonly agent: string | undefined;
  readonly session: string | undefined;
}

export interface SessionsFlags extends BaseFlags {
  readonly command: "sessions";
  readonly subcommand: "list" | undefined;
  readonly manifest: string | undefined;
  readonly limit: number;
}

export interface LogsFlags extends BaseFlags {
  readonly command: "logs";
  readonly manifest: string | undefined;
  readonly follow: boolean;
  readonly lines: number;
}

export interface StatusFlags extends BaseFlags {
  readonly command: "status";
  readonly manifest: string | undefined;
  readonly timeout: number | undefined;
  readonly json: boolean;
}

export interface DoctorFlags extends BaseFlags {
  readonly command: "doctor";
  readonly manifest: string | undefined;
  readonly repair: boolean;
  readonly json: boolean;
}

export interface StopFlags extends BaseFlags {
  readonly command: "stop";
  readonly manifest: string | undefined;
}

export interface DeployFlags extends BaseFlags {
  readonly command: "deploy";
  readonly manifest: string | undefined;
  readonly system: boolean;
  readonly uninstall: boolean;
  readonly port: number | undefined;
}

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
  | BaseFlags;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractCommand(argv: readonly string[]): {
  readonly command: string | undefined;
  readonly rest: readonly string[];
} {
  const first = argv[0];
  if (first === undefined || first.startsWith("-")) {
    return { command: undefined, rest: argv };
  }
  return { command: first, rest: argv.slice(1) };
}

function resolveLogFormat(flagValue: string | undefined): "text" | "json" {
  const raw = flagValue ?? process.env["LOG_FORMAT"];
  return raw === "json" ? "json" : "text";
}

function detectGlobalFlags(argv: readonly string[]): {
  readonly version: boolean;
  readonly help: boolean;
} {
  let version = false;
  let help = false;
  for (const arg of argv) {
    if (arg === "--version" || arg === "-V") version = true;
    if (arg === "--help" || arg === "-h") help = true;
  }
  return { version, help };
}

// ---------------------------------------------------------------------------
// Command-specific parsers
// ---------------------------------------------------------------------------

type GlobalFlags = { readonly version: boolean; readonly help: boolean };

function parseInitFlags(rest: readonly string[], g: GlobalFlags): InitFlags {
  const { values, positionals } = nodeParseArgs({
    args: rest as string[],
    options: {
      yes: { type: "boolean", short: "y", default: false },
      name: { type: "string" },
      template: { type: "string" },
      model: { type: "string" },
      engine: { type: "string" },
    },
    strict: false,
    allowPositionals: true,
  });
  return {
    command: "init" as const,
    directory: positionals[0] as string | undefined,
    version: g.version,
    help: g.help,
    yes: (values.yes as boolean | undefined) ?? false,
    name: values.name as string | undefined,
    template: values.template as string | undefined,
    model: values.model as string | undefined,
    engine: values.engine as string | undefined,
  };
}

function parseStartFlags(rest: readonly string[], g: GlobalFlags): StartFlags {
  const { values, positionals } = nodeParseArgs({
    args: rest as string[],
    options: {
      manifest: { type: "string" },
      verbose: { type: "boolean", short: "v", default: false },
      "dry-run": { type: "boolean", default: false },
      "log-format": { type: "string" },
    },
    strict: false,
    allowPositionals: true,
  });
  const positionalManifest = positionals[0] as string | undefined;
  return {
    command: "start" as const,
    directory: positionalManifest,
    version: g.version,
    help: g.help,
    manifest: (values.manifest as string | undefined) ?? positionalManifest,
    verbose: (values.verbose as boolean | undefined) ?? false,
    dryRun: (values["dry-run"] as boolean | undefined) ?? false,
    logFormat: resolveLogFormat(values["log-format"] as string | undefined),
  };
}

function parseServeFlags(rest: readonly string[], g: GlobalFlags): ServeFlags {
  const { values, positionals } = nodeParseArgs({
    args: rest as string[],
    options: {
      manifest: { type: "string" },
      port: { type: "string", short: "p" },
      verbose: { type: "boolean", short: "v", default: false },
      "log-format": { type: "string" },
    },
    strict: false,
    allowPositionals: true,
  });
  const positionalManifest = positionals[0] as string | undefined;
  const portStr = values.port as string | undefined;
  return {
    command: "serve" as const,
    directory: positionalManifest,
    version: g.version,
    help: g.help,
    manifest: (values.manifest as string | undefined) ?? positionalManifest,
    port: portStr !== undefined ? Number.parseInt(portStr, 10) : undefined,
    verbose: (values.verbose as boolean | undefined) ?? false,
    logFormat: resolveLogFormat(values["log-format"] as string | undefined),
  };
}

function parseTuiFlags(rest: readonly string[], g: GlobalFlags): TuiFlags {
  const { values } = nodeParseArgs({
    args: rest as string[],
    options: { agent: { type: "string" }, session: { type: "string" } },
    strict: false,
    allowPositionals: true,
  });
  return {
    command: "tui" as const,
    directory: undefined,
    version: g.version,
    help: g.help,
    agent: values.agent as string | undefined,
    session: values.session as string | undefined,
  };
}

function parseSessionsFlags(rest: readonly string[], g: GlobalFlags): SessionsFlags {
  const { values, positionals } = nodeParseArgs({
    args: rest as string[],
    options: { manifest: { type: "string" }, limit: { type: "string", short: "n" } },
    strict: false,
    allowPositionals: true,
  });
  const sub = positionals[0] as string | undefined;
  const limitStr = values.limit as string | undefined;
  return {
    command: "sessions" as const,
    directory: undefined,
    version: g.version,
    help: g.help,
    subcommand: sub === "list" ? ("list" as const) : undefined,
    manifest: values.manifest as string | undefined,
    limit: limitStr !== undefined ? Number.parseInt(limitStr, 10) : 20,
  };
}

function parseLogsFlags(rest: readonly string[], g: GlobalFlags): LogsFlags {
  const { values, positionals } = nodeParseArgs({
    args: rest as string[],
    options: {
      manifest: { type: "string" },
      follow: { type: "boolean", short: "f", default: false },
      lines: { type: "string", short: "n" },
    },
    strict: false,
    allowPositionals: true,
  });
  const positionalManifest = positionals[0] as string | undefined;
  const linesStr = values.lines as string | undefined;
  return {
    command: "logs" as const,
    directory: positionalManifest,
    version: g.version,
    help: g.help,
    manifest: (values.manifest as string | undefined) ?? positionalManifest,
    follow: (values.follow as boolean | undefined) ?? false,
    lines: linesStr !== undefined ? Number.parseInt(linesStr, 10) : 50,
  };
}

function parseStatusFlags(rest: readonly string[], g: GlobalFlags): StatusFlags {
  const { values, positionals } = nodeParseArgs({
    args: rest as string[],
    options: {
      manifest: { type: "string" },
      timeout: { type: "string" },
      json: { type: "boolean", default: false },
    },
    strict: false,
    allowPositionals: true,
  });
  const positionalManifest = positionals[0] as string | undefined;
  const timeoutStr = values.timeout as string | undefined;
  return {
    command: "status" as const,
    directory: positionalManifest,
    version: g.version,
    help: g.help,
    manifest: (values.manifest as string | undefined) ?? positionalManifest,
    timeout: timeoutStr !== undefined ? Number.parseInt(timeoutStr, 10) : undefined,
    json: (values.json as boolean | undefined) ?? false,
  };
}

function parseDoctorFlags(rest: readonly string[], g: GlobalFlags): DoctorFlags {
  const { values, positionals } = nodeParseArgs({
    args: rest as string[],
    options: {
      manifest: { type: "string" },
      repair: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
    },
    strict: false,
    allowPositionals: true,
  });
  const positionalManifest = positionals[0] as string | undefined;
  return {
    command: "doctor" as const,
    directory: positionalManifest,
    version: g.version,
    help: g.help,
    manifest: (values.manifest as string | undefined) ?? positionalManifest,
    repair: (values.repair as boolean | undefined) ?? false,
    json: (values.json as boolean | undefined) ?? false,
  };
}

function parseStopFlags(rest: readonly string[], g: GlobalFlags): StopFlags {
  const { values, positionals } = nodeParseArgs({
    args: rest as string[],
    options: { manifest: { type: "string" } },
    strict: false,
    allowPositionals: true,
  });
  const positionalManifest = positionals[0] as string | undefined;
  return {
    command: "stop" as const,
    directory: positionalManifest,
    version: g.version,
    help: g.help,
    manifest: (values.manifest as string | undefined) ?? positionalManifest,
  };
}

function parseDeployFlags(rest: readonly string[], g: GlobalFlags): DeployFlags {
  const { values, positionals } = nodeParseArgs({
    args: rest as string[],
    options: {
      manifest: { type: "string" },
      system: { type: "boolean", default: false },
      uninstall: { type: "boolean", default: false },
      port: { type: "string", short: "p" },
    },
    strict: false,
    allowPositionals: true,
  });
  const positionalManifest = positionals[0] as string | undefined;
  const portStr = values.port as string | undefined;
  return {
    command: "deploy" as const,
    directory: positionalManifest,
    version: g.version,
    help: g.help,
    manifest: (values.manifest as string | undefined) ?? positionalManifest,
    system: (values.system as boolean | undefined) ?? false,
    uninstall: (values.uninstall as boolean | undefined) ?? false,
    port: portStr !== undefined ? Number.parseInt(portStr, 10) : undefined,
  };
}

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

export function isInitFlags(flags: CliFlags): flags is InitFlags {
  return flags.command === "init";
}
export function isStartFlags(flags: CliFlags): flags is StartFlags {
  return flags.command === "start";
}
export function isServeFlags(flags: CliFlags): flags is ServeFlags {
  return flags.command === "serve";
}
export function isTuiFlags(flags: CliFlags): flags is TuiFlags {
  return flags.command === "tui";
}
export function isSessionsFlags(flags: CliFlags): flags is SessionsFlags {
  return flags.command === "sessions";
}
export function isLogsFlags(flags: CliFlags): flags is LogsFlags {
  return flags.command === "logs";
}
export function isStatusFlags(flags: CliFlags): flags is StatusFlags {
  return flags.command === "status";
}
export function isDoctorFlags(flags: CliFlags): flags is DoctorFlags {
  return flags.command === "doctor";
}
export function isStopFlags(flags: CliFlags): flags is StopFlags {
  return flags.command === "stop";
}
export function isDeployFlags(flags: CliFlags): flags is DeployFlags {
  return flags.command === "deploy";
}

// ---------------------------------------------------------------------------
// Command registry
// ---------------------------------------------------------------------------

type CommandParser = (rest: readonly string[], g: GlobalFlags) => CliFlags;

const COMMAND_PARSERS: Readonly<Record<string, CommandParser>> = {
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
};

export const COMMAND_NAMES: readonly string[] = Object.keys(COMMAND_PARSERS);

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function parseArgs(argv: readonly string[]): CliFlags {
  const globalFlags = detectGlobalFlags(argv);
  const { command, rest } = extractCommand(argv);

  if (command !== undefined) {
    const parser = COMMAND_PARSERS[command];
    if (parser !== undefined) {
      return parser(rest, globalFlags);
    }
  }

  return { command, directory: undefined, ...globalFlags };
}
