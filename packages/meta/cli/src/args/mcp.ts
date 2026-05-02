import type { BaseFlags } from "./shared.js";
import { ParseError, typedParseArgs } from "./shared.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type McpSubcommand =
  | "list"
  | "auth"
  | "logout"
  | "debug"
  | "search"
  | "info"
  | "install"
  | "uninstall";

const VALID_SUBCOMMANDS: ReadonlySet<string> = new Set([
  "list",
  "auth",
  "logout",
  "debug",
  "search",
  "info",
  "install",
  "uninstall",
]);

const SUBCOMMANDS_REQUIRING_ARG: ReadonlySet<string> = new Set([
  "auth",
  "logout",
  "debug",
  "search",
  "info",
  "install",
  "uninstall",
]);

export interface McpFlags extends BaseFlags {
  readonly command: "mcp";
  /**
   * Undefined only when `help` or `version` is also true — see parser.
   */
  readonly subcommand: McpSubcommand | undefined;
  /** Positional arg: server name (auth/logout/debug/info/install/uninstall) or query (search). */
  readonly server: string | undefined;
  readonly json: boolean;
  /** Registry result limit (search). */
  readonly limit: number | undefined;
  /** Specific registry version for info/install. Defaults to "latest". */
  readonly registryVersion: string | undefined;
  /** Skip prompts for install. Implied by --json. */
  readonly yes: boolean;
  /** Skip the dry-run connection verification on install. */
  readonly skipVerify: boolean;
  /** Bypass local registry cache for search/info. */
  readonly noCache: boolean;
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

export function parseMcpFlags(rest: readonly string[]): McpFlags {
  type V = {
    readonly json: boolean | undefined;
    readonly help: boolean | undefined;
    readonly version: boolean | undefined;
    readonly limit: string | undefined;
    readonly "registry-version": string | undefined;
    readonly yes: boolean | undefined;
    readonly "skip-verify": boolean | undefined;
    readonly "no-cache": boolean | undefined;
  };
  const { values, positionals } = typedParseArgs<V>(
    {
      args: rest,
      options: {
        json: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
        version: { type: "boolean", short: "V", default: false },
        limit: { type: "string" },
        "registry-version": { type: "string" },
        yes: { type: "boolean", short: "y", default: false },
        "skip-verify": { type: "boolean", default: false },
        "no-cache": { type: "boolean", default: false },
      },
      allowPositionals: true,
    },
    "mcp",
  );

  const helpRequested = values.help ?? false;
  const versionRequested = values.version ?? false;
  const sub = positionals[0];
  const arg = positionals[1];

  if (!helpRequested && !versionRequested) {
    if (sub === undefined || !VALID_SUBCOMMANDS.has(sub)) {
      throw new ParseError(`koi mcp requires a subcommand: ${[...VALID_SUBCOMMANDS].join(", ")}`);
    }
    if (SUBCOMMANDS_REQUIRING_ARG.has(sub) && arg === undefined) {
      throw new ParseError(`koi mcp ${sub} requires a positional argument`);
    }
  }

  const subcommand: McpSubcommand | undefined =
    sub !== undefined && VALID_SUBCOMMANDS.has(sub) ? (sub as McpSubcommand) : undefined;

  const limit = parsePositiveInt(values.limit, "--limit");
  const json = values.json ?? false;

  return {
    command: "mcp" as const,
    version: versionRequested,
    help: helpRequested,
    subcommand,
    server: arg,
    json,
    limit,
    registryVersion: values["registry-version"],
    // --json implies --yes for non-interactive scripted use.
    yes: (values.yes ?? false) || json,
    skipVerify: values["skip-verify"] ?? false,
    noCache: values["no-cache"] ?? false,
  };
}

function parsePositiveInt(value: string | undefined, flagName: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new ParseError(`${flagName} must be a positive integer (got "${value}")`);
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// Type guard
// ---------------------------------------------------------------------------

export function isMcpFlags(flags: BaseFlags): flags is McpFlags {
  return flags.command === "mcp";
}
