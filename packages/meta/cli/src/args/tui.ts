import type { BaseFlags, GlobalFlags } from "./shared.js";
import { typedParseArgs } from "./shared.js";

export interface TuiFlags extends BaseFlags {
  readonly command: "tui";
  readonly agent: string | undefined;
  readonly session: string | undefined;
}

export function parseTuiFlags(rest: readonly string[], g: GlobalFlags): TuiFlags {
  type V = { readonly agent: string | undefined; readonly session: string | undefined };
  const { values } = typedParseArgs<V>(
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

export function isTuiFlags(flags: BaseFlags): flags is TuiFlags {
  return flags.command === "tui";
}
