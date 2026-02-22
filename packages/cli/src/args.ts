/**
 * CLI argument parser — subcommand-aware design using node:util parseArgs.
 *
 * Extracts the command name first, then dispatches to command-specific
 * flag parsing for `init` and `start` subcommands.
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
}

export type CliFlags = InitFlags | StartFlags | BaseFlags;

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

function parseInitFlags(rest: readonly string[]): InitFlags {
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

function parseStartFlags(rest: readonly string[]): StartFlags {
  const { values, positionals } = nodeParseArgs({
    args: rest as string[],
    options: {
      manifest: { type: "string" },
      verbose: { type: "boolean", short: "v", default: false },
      "dry-run": { type: "boolean", default: false },
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

  switch (command) {
    case "init":
      return parseInitFlags(rest);
    case "start":
      return parseStartFlags(rest);
    default:
      return { command, directory: undefined };
  }
}
