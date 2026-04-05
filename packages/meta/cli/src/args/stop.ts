import type { BaseFlags, GlobalFlags } from "./shared.js";
import { typedParseArgs } from "./shared.js";

export interface StopFlags extends BaseFlags {
  readonly command: "stop";
  readonly manifest: string | undefined;
}

export function parseStopFlags(rest: readonly string[], g: GlobalFlags): StopFlags {
  type V = { readonly manifest: string | undefined };
  const { values, positionals } = typedParseArgs<V>(
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

export function isStopFlags(flags: BaseFlags): flags is StopFlags {
  return flags.command === "stop";
}
