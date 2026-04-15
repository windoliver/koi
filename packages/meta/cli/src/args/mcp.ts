import type { BaseFlags, GlobalFlags } from "./shared.js";
import { ParseError, typedParseArgs } from "./shared.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type McpSubcommand = "list" | "auth" | "logout" | "debug";

const VALID_SUBCOMMANDS: ReadonlySet<string> = new Set(["list", "auth", "logout", "debug"]);

export interface McpFlags extends BaseFlags {
  readonly command: "mcp";
  /**
   * Undefined only when `help` or `version` is also true — in that case
   * the parser preserves invalid argv (missing/unknown subcommand) as
   * invalid instead of coercing it to a synthetic `"list"`. Callers that
   * branch on `subcommand` MUST check `help`/`version` first.
   */
  readonly subcommand: McpSubcommand | undefined;
  /** Server name (required for auth, logout, debug). */
  readonly server: string | undefined;
  readonly json: boolean;
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

export function parseMcpFlags(rest: readonly string[], g: GlobalFlags): McpFlags {
  type V = {
    readonly json: boolean | undefined;
    readonly help: boolean | undefined;
    readonly version: boolean | undefined;
  };
  const { values, positionals } = typedParseArgs<V>(
    {
      args: rest,
      options: {
        json: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
        version: { type: "boolean", short: "V", default: false },
      },
      allowPositionals: true,
    },
    "mcp",
  );

  const helpRequested = values.help ?? g.help;
  const versionRequested = values.version ?? g.version;
  const sub = positionals[0];
  const server = positionals[1];

  // When --help or --version is present, defer the subcommand/server
  // validation so dispatch can serve help/version instead of a usage
  // error. subcommand falls back to "list" for shape compatibility.
  if (!helpRequested && !versionRequested) {
    if (sub === undefined || !VALID_SUBCOMMANDS.has(sub)) {
      throw new ParseError(`koi mcp requires a subcommand: ${[...VALID_SUBCOMMANDS].join(", ")}`);
    }
    const requireServer = sub !== "list";
    if (requireServer && server === undefined) {
      throw new ParseError(`koi mcp ${sub} requires a server name`);
    }
  }

  const subcommand: McpSubcommand | undefined =
    sub !== undefined && VALID_SUBCOMMANDS.has(sub) ? (sub as McpSubcommand) : undefined;

  return {
    command: "mcp" as const,
    version: versionRequested,
    help: helpRequested,
    subcommand,
    server,
    json: values.json ?? false,
  };
}

// ---------------------------------------------------------------------------
// Type guard
// ---------------------------------------------------------------------------

export function isMcpFlags(flags: BaseFlags): flags is McpFlags {
  return flags.command === "mcp";
}
