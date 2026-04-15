import type { BaseFlags, GlobalFlags } from "./shared.js";
import { parseIntFlag, typedParseArgs } from "./shared.js";

export interface SessionsFlags extends BaseFlags {
  readonly command: "sessions";
  readonly subcommand: "list" | undefined;
  readonly manifest: string | undefined;
  readonly limit: number;
}

export function parseSessionsFlags(rest: readonly string[], g: GlobalFlags): SessionsFlags {
  type V = {
    readonly manifest: string | undefined;
    readonly limit: string | undefined;
    readonly help: boolean | undefined;
    readonly version: boolean | undefined;
  };
  const { values, positionals } = typedParseArgs<V>(
    {
      args: rest,
      options: {
        manifest: { type: "string" },
        limit: { type: "string", short: "n" },
        help: { type: "boolean", short: "h", default: false },
        version: { type: "boolean", short: "V", default: false },
      },
      allowPositionals: true,
    },
    "sessions",
  );
  const sub = positionals[0];
  const helpRequested = values.help ?? g.help;
  const versionRequested = values.version ?? g.version;
  if (helpRequested || versionRequested) {
    return {
      command: "sessions" as const,
      version: versionRequested,
      help: helpRequested,
      subcommand: sub === "list" ? ("list" as const) : undefined,
      manifest: values.manifest,
      limit: 20,
    };
  }
  return {
    command: "sessions" as const,
    version: versionRequested,
    help: helpRequested,
    subcommand: sub === "list" ? ("list" as const) : undefined,
    manifest: values.manifest,
    limit:
      values.limit !== undefined
        ? parseIntFlag("limit", values.limit, 1, Number.MAX_SAFE_INTEGER)
        : 20,
  };
}

export function isSessionsFlags(flags: BaseFlags): flags is SessionsFlags {
  return flags.command === "sessions";
}
