import type { BaseFlags } from "./shared.js";
import { parseIntFlagSafe, typedParseArgs } from "./shared.js";

export interface LogsFlags extends BaseFlags {
  readonly command: "logs";
  readonly manifest: string | undefined;
  readonly follow: boolean;
  readonly lines: number;
}

export function parseLogsFlags(rest: readonly string[]): LogsFlags {
  type V = {
    readonly manifest: string | undefined;
    readonly follow: boolean | undefined;
    readonly lines: string | undefined;
    readonly help: boolean | undefined;
    readonly version: boolean | undefined;
  };
  const { values, positionals } = typedParseArgs<V>(
    {
      args: rest,
      options: {
        manifest: { type: "string" },
        follow: { type: "boolean", short: "f", default: false },
        lines: { type: "string", short: "n" },
        help: { type: "boolean", short: "h", default: false },
        version: { type: "boolean", short: "V", default: false },
      },
      allowPositionals: true,
    },
    "logs",
  );
  const helpRequested = values.help ?? false;
  const versionRequested = values.version ?? false;
  const skipValidators = helpRequested || versionRequested;
  return {
    command: "logs" as const,
    version: versionRequested,
    help: helpRequested,
    manifest: values.manifest ?? positionals[0],
    follow: values.follow ?? false,
    lines:
      values.lines !== undefined
        ? parseIntFlagSafe("lines", values.lines, 1, Number.MAX_SAFE_INTEGER, skipValidators, 50)
        : 50,
  };
}

export function isLogsFlags(flags: BaseFlags): flags is LogsFlags {
  return flags.command === "logs";
}
