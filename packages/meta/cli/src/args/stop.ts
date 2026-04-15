import type { BaseFlags } from "./shared.js";
import { typedParseArgs } from "./shared.js";

export interface StopFlags extends BaseFlags {
  readonly command: "stop";
  readonly manifest: string | undefined;
}

export function parseStopFlags(rest: readonly string[]): StopFlags {
  type V = {
    readonly manifest: string | undefined;
    readonly help: boolean | undefined;
    readonly version: boolean | undefined;
  };
  const { values, positionals } = typedParseArgs<V>(
    {
      args: rest,
      options: {
        manifest: { type: "string" },
        help: { type: "boolean", short: "h", default: false },
        version: { type: "boolean", short: "V", default: false },
      },
      allowPositionals: true,
    },
    "stop",
  );
  return {
    command: "stop" as const,
    version: values.version ?? false,
    help: values.help ?? false,
    manifest: values.manifest ?? positionals[0],
  };
}

export function isStopFlags(flags: BaseFlags): flags is StopFlags {
  return flags.command === "stop";
}
