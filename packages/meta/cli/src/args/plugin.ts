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
  readonly subcommand: PluginSubcommand;
  readonly name: string | undefined;
  readonly path: string | undefined;
  readonly json: boolean;
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

export function parsePluginFlags(rest: readonly string[], g: GlobalFlags): PluginFlags {
  type V = { readonly json: boolean | undefined };
  const { values, positionals } = typedParseArgs<V>(
    {
      args: rest,
      options: {
        json: { type: "boolean", default: false },
      },
      allowPositionals: true,
    },
    "plugin",
  );

  const sub = positionals[0];
  if (sub === undefined || !VALID_SUBCOMMANDS.has(sub)) {
    throw new ParseError(`koi plugin requires a subcommand: ${[...VALID_SUBCOMMANDS].join(", ")}`);
  }

  const subcommand = sub as PluginSubcommand;

  // install: koi plugin install <path>       → name=undefined, path=pos[1]
  // update:  koi plugin update <name> <path> → name=pos[1], path=pos[2]
  // others:  koi plugin <sub> <name>         → name=pos[1], path=undefined
  const name = subcommand === "install" ? undefined : positionals[1];
  const path = subcommand === "install" ? positionals[1] : positionals[2];

  return {
    command: "plugin" as const,
    version: g.version,
    help: g.help,
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
