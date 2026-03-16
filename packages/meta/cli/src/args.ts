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
}

export interface InitFlags extends BaseFlags {
  readonly command: "init";
  readonly yes: boolean;
  readonly name: string | undefined;
  readonly template: string | undefined;
  readonly model: string | undefined;
  readonly engine: string | undefined;
  readonly preset: string | undefined;
  readonly withAddons: readonly string[];
  readonly demo: string | undefined;
}

export interface StartFlags extends BaseFlags {
  readonly command: "start";
  readonly manifest: string | undefined;
  readonly verbose: boolean;
  readonly dryRun: boolean;
  readonly nexusUrl: string | undefined;
  readonly admin: boolean;
  readonly temporalUrl: string | undefined;
  readonly logFormat: "text" | "json";
}

export interface ServeFlags extends BaseFlags {
  readonly command: "serve";
  readonly manifest: string | undefined;
  readonly port: number | undefined;
  readonly verbose: boolean;
  readonly nexusUrl: string | undefined;
  readonly admin: boolean;
  readonly adminPort: number | undefined;
  readonly temporalUrl: string | undefined;
  readonly logFormat: "text" | "json";
}

export interface AdminFlags extends BaseFlags {
  readonly command: "admin";
  readonly manifest: string | undefined;
  readonly port: number | undefined;
  readonly verbose: boolean;
  readonly open: boolean;
  readonly temporalUrl: string | undefined;
  /** Connect to a running koi serve instance (e.g. "localhost:9100"). */
  readonly connect: string | undefined;
}

export interface DeployFlags extends BaseFlags {
  readonly command: "deploy";
  readonly manifest: string | undefined;
  readonly system: boolean;
  readonly uninstall: boolean;
  readonly port: number | undefined;
}

export interface StatusFlags extends BaseFlags {
  readonly command: "status";
  readonly manifest: string | undefined;
}

export interface StopFlags extends BaseFlags {
  readonly command: "stop";
  readonly manifest: string | undefined;
  readonly nexus: boolean;
}

export interface LogsFlags extends BaseFlags {
  readonly command: "logs";
  readonly manifest: string | undefined;
  readonly follow: boolean;
  readonly lines: number;
}

export interface TuiFlags extends BaseFlags {
  readonly command: "tui";
  /** Admin API URL (e.g., "http://localhost:3100/admin/api"). --url or --admin-url. */
  readonly url: string | undefined;
  /** Auth token for the admin API. */
  readonly authToken: string | undefined;
  /** Refresh interval in seconds (default: 5). */
  readonly refresh: number;
  /** Auto-attach to a specific agent on launch. */
  readonly agent: string | undefined;
  /** Resume a specific session (requires --agent). */
  readonly session: string | undefined;
}

export interface DoctorFlags extends BaseFlags {
  readonly command: "doctor";
  readonly manifest: string | undefined;
  readonly repair: boolean;
}

export interface UpFlags extends BaseFlags {
  readonly command: "up";
  readonly manifest: string | undefined;
  readonly verbose: boolean;
  readonly detach: boolean;
  readonly web: boolean;
  readonly timing: boolean;
  readonly nexusUrl: string | undefined;
  readonly nexusBuild: boolean;
  readonly nexusSource: string | undefined;
  readonly nexusPort: number | undefined;
  readonly temporalUrl: string | undefined;
  readonly logFormat: "text" | "json";
}

export interface ReplayFlags extends BaseFlags {
  readonly command: "replay";
  readonly session: string | undefined;
  readonly turn: number | undefined;
  readonly db: string | undefined;
  readonly events: boolean;
}

export interface DemoFlags extends BaseFlags {
  readonly command: "demo";
  readonly subcommand: "init" | "list" | "reset" | undefined;
  readonly pack: string | undefined;
  readonly manifest: string | undefined;
  readonly verbose: boolean;
}

export type CliFlags =
  | InitFlags
  | StartFlags
  | ServeFlags
  | AdminFlags
  | DeployFlags
  | StatusFlags
  | StopFlags
  | LogsFlags
  | TuiFlags
  | DoctorFlags
  | UpFlags
  | ReplayFlags
  | DemoFlags
  | BaseFlags;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Splits raw argv into the command name (first positional) and remaining args.
 */
function extractCommand(argv: readonly string[]): {
  readonly command: string | undefined;
  readonly rest: readonly string[];
} {
  const first = argv[0];

  // If first arg is a flag, there's no command
  if (first === undefined || first.startsWith("-")) {
    return { command: undefined, rest: argv };
  }

  return { command: first, rest: argv.slice(1) };
}

/**
 * Resolves log format from a flag value or the LOG_FORMAT env var.
 * Returns "text" unless explicitly set to "json".
 */
function resolveLogFormat(flagValue: string | undefined): "text" | "json" {
  const raw = flagValue ?? process.env.LOG_FORMAT;
  return raw === "json" ? "json" : "text";
}

// ---------------------------------------------------------------------------
// Command-specific parsers
// ---------------------------------------------------------------------------

export function parseInitFlags(rest: readonly string[]): InitFlags {
  const { values, positionals } = nodeParseArgs({
    args: rest as string[],
    options: {
      yes: { type: "boolean", short: "y", default: false },
      name: { type: "string" },
      template: { type: "string" },
      model: { type: "string" },
      engine: { type: "string" },
      preset: { type: "string" },
      with: { type: "string", multiple: true },
      demo: { type: "string" },
    },
    strict: false,
    allowPositionals: true,
  });

  return {
    command: "init" as const,
    directory: positionals[0] as string | undefined,
    yes: (values.yes as boolean | undefined) ?? false,
    name: values.name as string | undefined,
    template: values.template as string | undefined,
    model: values.model as string | undefined,
    engine: values.engine as string | undefined,
    preset: values.preset as string | undefined,
    withAddons: (values.with as string[] | undefined) ?? [],
    demo: values.demo as string | undefined,
  };
}

export function parseStartFlags(rest: readonly string[]): StartFlags {
  const { values, positionals } = nodeParseArgs({
    args: rest as string[],
    options: {
      manifest: { type: "string" },
      verbose: { type: "boolean", short: "v", default: false },
      "dry-run": { type: "boolean", default: false },
      "nexus-url": { type: "string" },
      admin: { type: "boolean", default: false },
      "temporal-url": { type: "string" },
      "log-format": { type: "string" },
    },
    strict: false,
    allowPositionals: true,
  });

  // First positional after "start" can be a manifest path
  const positionalManifest = positionals[0] as string | undefined;

  return {
    command: "start" as const,
    directory: positionalManifest,
    manifest: (values.manifest as string | undefined) ?? positionalManifest,
    verbose: (values.verbose as boolean | undefined) ?? false,
    dryRun: (values["dry-run"] as boolean | undefined) ?? false,
    nexusUrl: values["nexus-url"] as string | undefined,
    admin: (values.admin as boolean | undefined) ?? false,
    temporalUrl: values["temporal-url"] as string | undefined,
    logFormat: resolveLogFormat(values["log-format"] as string | undefined),
  };
}

export function parseServeFlags(rest: readonly string[]): ServeFlags {
  const { values, positionals } = nodeParseArgs({
    args: rest as string[],
    options: {
      manifest: { type: "string" },
      port: { type: "string", short: "p" },
      verbose: { type: "boolean", short: "v", default: false },
      "nexus-url": { type: "string" },
      admin: { type: "boolean", default: false },
      "admin-port": { type: "string" },
      "temporal-url": { type: "string" },
      "log-format": { type: "string" },
    },
    strict: false,
    allowPositionals: true,
  });

  const positionalManifest = positionals[0] as string | undefined;
  const portStr = values.port as string | undefined;
  const adminPortStr = values["admin-port"] as string | undefined;

  return {
    command: "serve" as const,
    directory: positionalManifest,
    manifest: (values.manifest as string | undefined) ?? positionalManifest,
    port: portStr !== undefined ? Number.parseInt(portStr, 10) : undefined,
    verbose: (values.verbose as boolean | undefined) ?? false,
    nexusUrl: values["nexus-url"] as string | undefined,
    admin: (values.admin as boolean | undefined) ?? false,
    adminPort: adminPortStr !== undefined ? Number.parseInt(adminPortStr, 10) : undefined,
    temporalUrl: values["temporal-url"] as string | undefined,
    logFormat: resolveLogFormat(values["log-format"] as string | undefined),
  };
}

export function parseDeployFlags(rest: readonly string[]): DeployFlags {
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
    manifest: (values.manifest as string | undefined) ?? positionalManifest,
    system: (values.system as boolean | undefined) ?? false,
    uninstall: (values.uninstall as boolean | undefined) ?? false,
    port: portStr !== undefined ? Number.parseInt(portStr, 10) : undefined,
  };
}

export function parseStatusFlags(rest: readonly string[]): StatusFlags {
  const { values, positionals } = nodeParseArgs({
    args: rest as string[],
    options: {
      manifest: { type: "string" },
    },
    strict: false,
    allowPositionals: true,
  });

  const positionalManifest = positionals[0] as string | undefined;

  return {
    command: "status" as const,
    directory: positionalManifest,
    manifest: (values.manifest as string | undefined) ?? positionalManifest,
  };
}

export function parseStopFlags(rest: readonly string[]): StopFlags {
  const { values, positionals } = nodeParseArgs({
    args: rest as string[],
    options: {
      manifest: { type: "string" },
      nexus: { type: "boolean", default: false },
    },
    strict: false,
    allowPositionals: true,
  });

  const positionalManifest = positionals[0] as string | undefined;

  return {
    command: "stop" as const,
    directory: positionalManifest,
    manifest: (values.manifest as string | undefined) ?? positionalManifest,
    nexus: (values.nexus as boolean | undefined) ?? false,
  };
}

export function parseLogsFlags(rest: readonly string[]): LogsFlags {
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
    manifest: (values.manifest as string | undefined) ?? positionalManifest,
    follow: (values.follow as boolean | undefined) ?? false,
    lines: linesStr !== undefined ? Number.parseInt(linesStr, 10) : 50,
  };
}

export function parseAdminFlags(rest: readonly string[]): AdminFlags {
  const { values, positionals } = nodeParseArgs({
    args: rest as string[],
    options: {
      manifest: { type: "string" },
      port: { type: "string", short: "p" },
      verbose: { type: "boolean", short: "v", default: false },
      open: { type: "boolean", default: true },
      "no-open": { type: "boolean", default: false },
      "temporal-url": { type: "string" },
      connect: { type: "string" },
    },
    strict: false,
    allowPositionals: true,
  });

  const positionalManifest = positionals[0] as string | undefined;
  const portStr = values.port as string | undefined;
  // --no-open overrides --open (default true)
  const shouldOpen =
    values["no-open"] === true ? false : ((values.open as boolean | undefined) ?? true);

  return {
    command: "admin" as const,
    directory: positionalManifest,
    manifest: (values.manifest as string | undefined) ?? positionalManifest,
    port: portStr !== undefined ? Number.parseInt(portStr, 10) : undefined,
    verbose: (values.verbose as boolean | undefined) ?? false,
    open: shouldOpen,
    temporalUrl: values["temporal-url"] as string | undefined,
    connect: values.connect as string | undefined,
  };
}

export function parseTuiFlags(rest: readonly string[]): TuiFlags {
  const { values } = nodeParseArgs({
    args: rest as string[],
    options: {
      url: { type: "string" },
      "admin-url": { type: "string" },
      token: { type: "string" },
      refresh: { type: "string" },
      agent: { type: "string" },
      session: { type: "string" },
    },
    strict: false,
    allowPositionals: true,
  });

  const refreshStr = values.refresh as string | undefined;
  // --admin-url is an alias for --url
  const urlValue =
    (values.url as string | undefined) ?? (values["admin-url"] as string | undefined);

  return {
    command: "tui" as const,
    directory: undefined,
    url: urlValue,
    authToken: values.token as string | undefined,
    refresh: refreshStr !== undefined ? Number.parseInt(refreshStr, 10) : 5,
    agent: values.agent as string | undefined,
    session: values.session as string | undefined,
  };
}

export function parseUpFlags(rest: readonly string[]): UpFlags {
  const { values, positionals } = nodeParseArgs({
    args: rest as string[],
    options: {
      manifest: { type: "string" },
      verbose: { type: "boolean", short: "v", default: false },
      detach: { type: "boolean", default: false },
      web: { type: "boolean", default: false },
      timing: { type: "boolean", default: false },
      "nexus-url": { type: "string" },
      "nexus-build": { type: "boolean", default: false },
      "nexus-source": { type: "string" },
      "nexus-port": { type: "string" },
      "temporal-url": { type: "string" },
      "log-format": { type: "string" },
    },
    strict: false,
    allowPositionals: true,
  });

  const positionalManifest = positionals[0] as string | undefined;
  const nexusPortStr = values["nexus-port"] as string | undefined;

  return {
    command: "up" as const,
    directory: positionalManifest,
    manifest: (values.manifest as string | undefined) ?? positionalManifest,
    verbose: (values.verbose as boolean | undefined) ?? false,
    detach: (values.detach as boolean | undefined) ?? false,
    web: (values.web as boolean | undefined) ?? false,
    timing: (values.timing as boolean | undefined) ?? false,
    nexusUrl: values["nexus-url"] as string | undefined,
    nexusBuild: (values["nexus-build"] as boolean | undefined) ?? false,
    nexusSource: values["nexus-source"] as string | undefined,
    nexusPort: nexusPortStr !== undefined ? Number.parseInt(nexusPortStr, 10) : undefined,
    temporalUrl: values["temporal-url"] as string | undefined,
    logFormat: resolveLogFormat(values["log-format"] as string | undefined),
  };
}

export function parseDemoFlags(rest: readonly string[]): DemoFlags {
  const { values, positionals } = nodeParseArgs({
    args: rest as string[],
    options: {
      manifest: { type: "string" },
      verbose: { type: "boolean", short: "v", default: false },
    },
    strict: false,
    allowPositionals: true,
  });

  // First positional is the subcommand (init, list, reset)
  const sub = positionals[0] as string | undefined;
  const validSubs = ["init", "list", "reset"] as const;
  const subcommand =
    sub !== undefined && (validSubs as readonly string[]).includes(sub)
      ? (sub as "init" | "list" | "reset")
      : undefined;

  // Second positional is the pack ID
  const pack = positionals[1] as string | undefined;

  return {
    command: "demo" as const,
    directory: undefined,
    subcommand,
    pack,
    manifest: values.manifest as string | undefined,
    verbose: (values.verbose as boolean | undefined) ?? false,
  };
}

export function parseDoctorFlags(rest: readonly string[]): DoctorFlags {
  const { values, positionals } = nodeParseArgs({
    args: rest as string[],
    options: {
      manifest: { type: "string" },
      repair: { type: "boolean", default: false },
    },
    strict: false,
    allowPositionals: true,
  });

  const positionalManifest = positionals[0] as string | undefined;

  return {
    command: "doctor" as const,
    directory: positionalManifest,
    manifest: (values.manifest as string | undefined) ?? positionalManifest,
    repair: (values.repair as boolean | undefined) ?? false,
  };
}

export function parseReplayFlags(rest: readonly string[]): ReplayFlags {
  const { values } = nodeParseArgs({
    args: rest as string[],
    options: {
      session: { type: "string" },
      turn: { type: "string" },
      db: { type: "string" },
      events: { type: "boolean", default: false },
    },
    strict: false,
    allowPositionals: true,
  });

  const turnStr = values.turn as string | undefined;

  return {
    command: "replay" as const,
    directory: undefined,
    session: values.session as string | undefined,
    turn: turnStr !== undefined ? Number.parseInt(turnStr, 10) : undefined,
    db: values.db as string | undefined,
    events: (values.events as boolean | undefined) ?? false,
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

export function isAdminFlags(flags: CliFlags): flags is AdminFlags {
  return flags.command === "admin";
}

export function isDeployFlags(flags: CliFlags): flags is DeployFlags {
  return flags.command === "deploy";
}

export function isStatusFlags(flags: CliFlags): flags is StatusFlags {
  return flags.command === "status";
}

export function isStopFlags(flags: CliFlags): flags is StopFlags {
  return flags.command === "stop";
}

export function isLogsFlags(flags: CliFlags): flags is LogsFlags {
  return flags.command === "logs";
}

export function isTuiFlags(flags: CliFlags): flags is TuiFlags {
  return flags.command === "tui";
}

export function isDoctorFlags(flags: CliFlags): flags is DoctorFlags {
  return flags.command === "doctor";
}

export function isUpFlags(flags: CliFlags): flags is UpFlags {
  return flags.command === "up";
}

export function isReplayFlags(flags: CliFlags): flags is ReplayFlags {
  return flags.command === "replay";
}

export function isDemoFlags(flags: CliFlags): flags is DemoFlags {
  return flags.command === "demo";
}

// ---------------------------------------------------------------------------
// Command registry
// ---------------------------------------------------------------------------

/** Maps command names to their parsers. */
const COMMAND_PARSERS: Readonly<Record<string, (rest: readonly string[]) => CliFlags>> = {
  init: parseInitFlags,
  start: parseStartFlags,
  serve: parseServeFlags,
  admin: parseAdminFlags,
  deploy: parseDeployFlags,
  status: parseStatusFlags,
  stop: parseStopFlags,
  logs: parseLogsFlags,
  tui: parseTuiFlags,
  doctor: parseDoctorFlags,
  up: parseUpFlags,
  replay: parseReplayFlags,
  demo: parseDemoFlags,
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parses CLI arguments into a typed flags object based on the subcommand.
 *
 * @param argv - Raw arguments (typically `process.argv.slice(2)`)
 * @returns Typed flags for the detected command
 */
export function parseArgs(argv: readonly string[]): CliFlags {
  const { command, rest } = extractCommand(argv);

  if (command !== undefined) {
    const parser = COMMAND_PARSERS[command];
    if (parser !== undefined) {
      return parser(rest);
    }
  }

  return { command, directory: undefined };
}
