/**
 * CLI argument parser — subcommand-aware design using node:util parseArgs.
 *
 * Design notes:
 * - Unknown flags are rejected via tokens inspection inside typedParseArgs
 * - Invalid numeric values are rejected at parse time via parseIntFlag
 * - resolveLogFormat rejects invalid values; reads LOG_FORMAT env var as fallback
 * - Global flags (--help/-h, --version/-V) are stripped before command parsing
 *   so they never trigger "unknown flag" errors in per-command parsers
 */

import { parseArgs as nodeParseArgs } from "node:util";

// ---------------------------------------------------------------------------
// Flag types
// ---------------------------------------------------------------------------

export interface BaseFlags {
  readonly command: string | undefined;
  readonly version: boolean;
  readonly help: boolean;
}

export interface InitFlags extends BaseFlags {
  readonly command: "init";
  readonly directory: string | undefined;
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
// Token type for unknown-flag detection
// ---------------------------------------------------------------------------

type ParseToken =
  | {
      readonly kind: "option";
      readonly name: string;
      readonly rawName: string;
      readonly value: string | undefined;
      readonly inlineValue: boolean | undefined;
    }
  | { readonly kind: "positional"; readonly value: string }
  | { readonly kind: "option-terminator" };

// ---------------------------------------------------------------------------
// Internal option-config shape (mirrors node:util parseArgs options)
// ---------------------------------------------------------------------------

type OptionConfig = {
  readonly type: "string" | "boolean";
  readonly short?: string;
  readonly multiple?: boolean;
  readonly default?: string | boolean;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Typed wrapper around node:util parseArgs.
 *
 * Isolates the single justified cast boundary with the external nodeParseArgs
 * API (complex overloads + tokens: true return type). All callers get fully
 * typed values via T with zero scattered casts.
 *
 * Also enforces unknown-flag rejection: any flag not in config.options causes
 * an error message to stderr and process.exit(1).
 */
function typedParseArgs<T extends Record<string, string | boolean | string[] | undefined>>(
  config: {
    readonly args: readonly string[];
    readonly options: Readonly<Record<string, OptionConfig>>;
    readonly allowPositionals?: boolean;
  },
  command: string,
): { readonly values: T; readonly positionals: readonly string[] } {
  // Justified double cast: nodeParseArgs overloads don't resolve cleanly when
  // tokens: true is added dynamically, and the return type is Record<string, mixed>.
  // Spreading args converts readonly string[] → string[] without an as-cast.
  const parseResult = nodeParseArgs({
    args: [...config.args],
    options: config.options,
    strict: false,
    allowPositionals: config.allowPositionals ?? false,
    tokens: true,
  } as unknown as Parameters<typeof nodeParseArgs>[0]) as unknown as {
    readonly values: Record<string, string | boolean | string[] | undefined>;
    readonly positionals: readonly string[];
    readonly tokens: ReadonlyArray<ParseToken>;
  };

  const knownFlags = new Set(Object.keys(config.options));
  for (const token of parseResult.tokens) {
    if (token.kind === "option" && !knownFlags.has(token.name)) {
      process.stderr.write(`error: unknown flag ${token.rawName} for 'koi ${command}'\n`);
      process.exit(1);
    }
  }

  return { values: parseResult.values as T, positionals: parseResult.positionals };
}

/** Validates a numeric CLI flag. Writes error and exits 1 on failure. */
function parseIntFlag(name: string, value: string, min: number, max: number): number {
  const n = Number.parseInt(value, 10);
  const range = max === Number.MAX_SAFE_INTEGER ? `≥ ${min}` : `${min}–${max}`;
  if (!Number.isFinite(n) || n < min || n > max) {
    process.stderr.write(`error: --${name} must be an integer (${range}), got '${value}'\n`);
    process.exit(1);
  }
  return n;
}

/** Resolves log format from flag value or LOG_FORMAT env var. Errors on invalid values. */
function resolveLogFormat(flagValue: string | undefined): "text" | "json" {
  const raw = flagValue ?? process.env.LOG_FORMAT;
  if (raw === undefined || raw === "text") return "text";
  if (raw === "json") return "json";
  process.stderr.write(`error: --log-format must be 'text' or 'json', got '${raw}'\n`);
  process.exit(1);
}

function detectGlobalFlags(argv: readonly string[]): {
  readonly version: boolean;
  readonly help: boolean;
} {
  return {
    version: argv.some((a) => a === "--version" || a === "-V"),
    help: argv.some((a) => a === "--help" || a === "-h"),
  };
}

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

// Stripped from rest before command dispatch so parsers never see them as unknown flags.
const GLOBAL_RAW_FLAGS = new Set(["--help", "-h", "--version", "-V"]);

// ---------------------------------------------------------------------------
// Command-specific parsers
// ---------------------------------------------------------------------------

type GlobalFlags = { readonly version: boolean; readonly help: boolean };

function parseInitFlags(rest: readonly string[], g: GlobalFlags): InitFlags {
  type InitValues = {
    readonly yes: boolean | undefined;
    readonly name: string | undefined;
    readonly template: string | undefined;
    readonly model: string | undefined;
    readonly engine: string | undefined;
  };
  const { values, positionals } = typedParseArgs<InitValues>(
    {
      args: rest,
      options: {
        yes: { type: "boolean", short: "y", default: false },
        name: { type: "string" },
        template: { type: "string" },
        model: { type: "string" },
        engine: { type: "string" },
      },
      allowPositionals: true,
    },
    "init",
  );
  return {
    command: "init" as const,
    directory: positionals[0],
    version: g.version,
    help: g.help,
    yes: values.yes ?? false,
    name: values.name,
    template: values.template,
    model: values.model,
    engine: values.engine,
  };
}

function parseStartFlags(rest: readonly string[], g: GlobalFlags): StartFlags {
  type StartValues = {
    readonly manifest: string | undefined;
    readonly verbose: boolean | undefined;
    readonly "dry-run": boolean | undefined;
    readonly "log-format": string | undefined;
  };
  const { values, positionals } = typedParseArgs<StartValues>(
    {
      args: rest,
      options: {
        manifest: { type: "string" },
        verbose: { type: "boolean", short: "v", default: false },
        "dry-run": { type: "boolean", default: false },
        "log-format": { type: "string" },
      },
      allowPositionals: true,
    },
    "start",
  );
  return {
    command: "start" as const,
    version: g.version,
    help: g.help,
    manifest: values.manifest ?? positionals[0],
    verbose: values.verbose ?? false,
    dryRun: values["dry-run"] ?? false,
    logFormat: resolveLogFormat(values["log-format"]),
  };
}

function parseServeFlags(rest: readonly string[], g: GlobalFlags): ServeFlags {
  type ServeValues = {
    readonly manifest: string | undefined;
    readonly port: string | undefined;
    readonly verbose: boolean | undefined;
    readonly "log-format": string | undefined;
  };
  const { values, positionals } = typedParseArgs<ServeValues>(
    {
      args: rest,
      options: {
        manifest: { type: "string" },
        port: { type: "string", short: "p" },
        verbose: { type: "boolean", short: "v", default: false },
        "log-format": { type: "string" },
      },
      allowPositionals: true,
    },
    "serve",
  );
  return {
    command: "serve" as const,
    version: g.version,
    help: g.help,
    manifest: values.manifest ?? positionals[0],
    port: values.port !== undefined ? parseIntFlag("port", values.port, 1, 65535) : undefined,
    verbose: values.verbose ?? false,
    logFormat: resolveLogFormat(values["log-format"]),
  };
}

function parseTuiFlags(rest: readonly string[], g: GlobalFlags): TuiFlags {
  type TuiValues = {
    readonly agent: string | undefined;
    readonly session: string | undefined;
  };
  const { values } = typedParseArgs<TuiValues>(
    {
      args: rest,
      options: { agent: { type: "string" }, session: { type: "string" } },
      allowPositionals: true,
    },
    "tui",
  );
  return {
    command: "tui" as const,
    version: g.version,
    help: g.help,
    agent: values.agent,
    session: values.session,
  };
}

function parseSessionsFlags(rest: readonly string[], g: GlobalFlags): SessionsFlags {
  type SessionsValues = {
    readonly manifest: string | undefined;
    readonly limit: string | undefined;
  };
  const { values, positionals } = typedParseArgs<SessionsValues>(
    {
      args: rest,
      options: {
        manifest: { type: "string" },
        limit: { type: "string", short: "n" },
      },
      allowPositionals: true,
    },
    "sessions",
  );
  const sub = positionals[0];
  return {
    command: "sessions" as const,
    version: g.version,
    help: g.help,
    subcommand: sub === "list" ? ("list" as const) : undefined,
    manifest: values.manifest,
    limit:
      values.limit !== undefined
        ? parseIntFlag("limit", values.limit, 1, Number.MAX_SAFE_INTEGER)
        : 20,
  };
}

function parseLogsFlags(rest: readonly string[], g: GlobalFlags): LogsFlags {
  type LogsValues = {
    readonly manifest: string | undefined;
    readonly follow: boolean | undefined;
    readonly lines: string | undefined;
  };
  const { values, positionals } = typedParseArgs<LogsValues>(
    {
      args: rest,
      options: {
        manifest: { type: "string" },
        follow: { type: "boolean", short: "f", default: false },
        lines: { type: "string", short: "n" },
      },
      allowPositionals: true,
    },
    "logs",
  );
  return {
    command: "logs" as const,
    version: g.version,
    help: g.help,
    manifest: values.manifest ?? positionals[0],
    follow: values.follow ?? false,
    lines:
      values.lines !== undefined
        ? parseIntFlag("lines", values.lines, 1, Number.MAX_SAFE_INTEGER)
        : 50,
  };
}

function parseStatusFlags(rest: readonly string[], g: GlobalFlags): StatusFlags {
  type StatusValues = {
    readonly manifest: string | undefined;
    readonly timeout: string | undefined;
    readonly json: boolean | undefined;
  };
  const { values, positionals } = typedParseArgs<StatusValues>(
    {
      args: rest,
      options: {
        manifest: { type: "string" },
        timeout: { type: "string" },
        json: { type: "boolean", default: false },
      },
      allowPositionals: true,
    },
    "status",
  );
  return {
    command: "status" as const,
    version: g.version,
    help: g.help,
    manifest: values.manifest ?? positionals[0],
    timeout:
      values.timeout !== undefined
        ? parseIntFlag("timeout", values.timeout, 1, Number.MAX_SAFE_INTEGER)
        : undefined,
    json: values.json ?? false,
  };
}

function parseDoctorFlags(rest: readonly string[], g: GlobalFlags): DoctorFlags {
  type DoctorValues = {
    readonly manifest: string | undefined;
    readonly repair: boolean | undefined;
    readonly json: boolean | undefined;
  };
  const { values, positionals } = typedParseArgs<DoctorValues>(
    {
      args: rest,
      options: {
        manifest: { type: "string" },
        repair: { type: "boolean", default: false },
        json: { type: "boolean", default: false },
      },
      allowPositionals: true,
    },
    "doctor",
  );
  return {
    command: "doctor" as const,
    version: g.version,
    help: g.help,
    manifest: values.manifest ?? positionals[0],
    repair: values.repair ?? false,
    json: values.json ?? false,
  };
}

function parseStopFlags(rest: readonly string[], g: GlobalFlags): StopFlags {
  type StopValues = { readonly manifest: string | undefined };
  const { values, positionals } = typedParseArgs<StopValues>(
    {
      args: rest,
      options: { manifest: { type: "string" } },
      allowPositionals: true,
    },
    "stop",
  );
  return {
    command: "stop" as const,
    version: g.version,
    help: g.help,
    manifest: values.manifest ?? positionals[0],
  };
}

function parseDeployFlags(rest: readonly string[], g: GlobalFlags): DeployFlags {
  type DeployValues = {
    readonly manifest: string | undefined;
    readonly system: boolean | undefined;
    readonly uninstall: boolean | undefined;
    readonly port: string | undefined;
  };
  const { values, positionals } = typedParseArgs<DeployValues>(
    {
      args: rest,
      options: {
        manifest: { type: "string" },
        system: { type: "boolean", default: false },
        uninstall: { type: "boolean", default: false },
        port: { type: "string", short: "p" },
      },
      allowPositionals: true,
    },
    "deploy",
  );
  return {
    command: "deploy" as const,
    version: g.version,
    help: g.help,
    manifest: values.manifest ?? positionals[0],
    system: values.system ?? false,
    uninstall: values.uninstall ?? false,
    port: values.port !== undefined ? parseIntFlag("port", values.port, 1, 65535) : undefined,
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
  | "deploy";

// Explicit annotation satisfies isolatedDeclarations (no typeof derivation).
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
];

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
};

export const COMMAND_NAMES: ReadonlyArray<KnownCommand> = KNOWN_COMMANDS;

export function isKnownCommand(cmd: string | undefined): cmd is KnownCommand {
  if (cmd === undefined) return false;
  for (const name of COMMAND_NAMES) {
    if (name === cmd) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function parseArgs(argv: readonly string[]): CliFlags {
  const globalFlags = detectGlobalFlags(argv);
  const { command, rest } = extractCommand(argv);

  // Strip global flags so per-command parsers never see them as unknown flags.
  const filteredRest = rest.filter((a) => !GLOBAL_RAW_FLAGS.has(a));

  if (isKnownCommand(command)) {
    return COMMAND_PARSERS[command](filteredRest, globalFlags);
  }

  return { command, ...globalFlags };
}
