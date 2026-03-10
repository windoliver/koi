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
}

export interface StartFlags extends BaseFlags {
  readonly command: "start";
  readonly manifest: string | undefined;
  readonly verbose: boolean;
  readonly dryRun: boolean;
  readonly nexusUrl: string | undefined;
  readonly admin: boolean;
}

export interface ServeFlags extends BaseFlags {
  readonly command: "serve";
  readonly manifest: string | undefined;
  readonly port: number | undefined;
  readonly verbose: boolean;
  readonly nexusUrl: string | undefined;
  readonly admin: boolean;
  readonly adminPort: number | undefined;
}

export interface AdminFlags extends BaseFlags {
  readonly command: "admin";
  readonly manifest: string | undefined;
  readonly port: number | undefined;
  readonly verbose: boolean;
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

export interface DoctorFlags extends BaseFlags {
  readonly command: "doctor";
  readonly manifest: string | undefined;
  readonly repair: boolean;
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
  | DoctorFlags
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
    },
    strict: false,
    allowPositionals: true,
  });

  const positionalManifest = positionals[0] as string | undefined;
  const portStr = values.port as string | undefined;

  return {
    command: "admin" as const,
    directory: positionalManifest,
    manifest: (values.manifest as string | undefined) ?? positionalManifest,
    port: portStr !== undefined ? Number.parseInt(portStr, 10) : undefined,
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

export function isDoctorFlags(flags: CliFlags): flags is DoctorFlags {
  return flags.command === "doctor";
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
  doctor: parseDoctorFlags,
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
