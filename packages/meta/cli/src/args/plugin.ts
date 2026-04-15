import type { BaseFlags, GlobalFlags } from "./shared.js";
import { ParseError, typedParseArgs } from "./shared.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PluginSubcommand = "install" | "remove" | "enable" | "disable" | "update" | "list";

const VALID_SUBCOMMANDS: ReadonlySet<string> = new Set([
  "install",
  "remove",
  "enable",
  "disable",
  "update",
  "list",
]);

export interface PluginFlags extends BaseFlags {
  readonly command: "plugin";
  /**
   * Undefined only when `help` or `version` is also true — in that case
   * the parser preserves invalid argv (missing/unknown subcommand) as
   * invalid instead of coercing it to a synthetic `"list"`. Callers that
   * branch on `subcommand` MUST check `help`/`version` first.
   */
  readonly subcommand: PluginSubcommand | undefined;
  readonly name: string | undefined;
  readonly path: string | undefined;
  readonly json: boolean;
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

export function parsePluginFlags(rest: readonly string[], g: GlobalFlags): PluginFlags {
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
    "plugin",
  );

  const helpRequested = values.help ?? g.help;
  const versionRequested = values.version ?? g.version;
  const sub = positionals[0];

  // When --help or --version is present, defer the subcommand-required
  // check so dispatch can serve help/version instead of a usage error.
  // subcommand falls back to "list" for shape compatibility; dispatch
  // exits before any command body reads it.
  if (!helpRequested && !versionRequested) {
    if (sub === undefined || !VALID_SUBCOMMANDS.has(sub)) {
      throw new ParseError(
        `koi plugin requires a subcommand: ${[...VALID_SUBCOMMANDS].join(", ")}`,
      );
    }
  }

  const subcommand: PluginSubcommand | undefined =
    sub !== undefined && VALID_SUBCOMMANDS.has(sub) ? (sub as PluginSubcommand) : undefined;

  // install: koi plugin install <path>       → name=undefined, path=pos[1]
  // update:  koi plugin update <name> <path> → name=pos[1], path=pos[2]
  // others:  koi plugin <sub> <name>         → name=pos[1], path=undefined
  const name = subcommand === "install" || subcommand === undefined ? undefined : positionals[1];
  const path = subcommand === "install" ? positionals[1] : positionals[2];

  return {
    command: "plugin" as const,
    version: versionRequested,
    help: helpRequested,
    subcommand,
    name,
    path,
    json: values.json ?? false,
  };
}

// ---------------------------------------------------------------------------
// Type guard
// ---------------------------------------------------------------------------

export function isPluginFlags(flags: BaseFlags): flags is PluginFlags {
  return flags.command === "plugin";
}
