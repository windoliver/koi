import type { BaseFlags, GlobalFlags } from "./shared.js";
import { ParseError, typedParseArgs } from "./shared.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type McpSubcommand = "list" | "auth" | "logout" | "debug";

const VALID_SUBCOMMANDS: ReadonlySet<string> = new Set(["list", "auth", "logout", "debug"]);

export interface McpFlags extends BaseFlags {
  readonly command: "mcp";
  readonly subcommand: McpSubcommand;
  /** Server name (required for auth, logout, debug). */
  readonly server: string | undefined;
  readonly json: boolean;
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

export function parseMcpFlags(rest: readonly string[], g: GlobalFlags): McpFlags {
  type V = { readonly json: boolean | undefined };
  const { values, positionals } = typedParseArgs<V>(
    {
      args: rest,
      options: {
        json: { type: "boolean", default: false },
      },
      allowPositionals: true,
    },
    "mcp",
  );

  const sub = positionals[0];
  if (sub === undefined || !VALID_SUBCOMMANDS.has(sub)) {
    throw new ParseError(`koi mcp requires a subcommand: ${[...VALID_SUBCOMMANDS].join(", ")}`);
  }

  const subcommand = sub as McpSubcommand;
  const server = positionals[1];

  // auth, logout, debug require a server name
  if (subcommand !== "list" && server === undefined) {
    throw new ParseError(`koi mcp ${subcommand} requires a server name`);
  }

  return {
    command: "mcp" as const,
    version: g.version,
    help: g.help,
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
