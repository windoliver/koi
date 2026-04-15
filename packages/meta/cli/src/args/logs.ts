import type { BaseFlags, GlobalFlags } from "./shared.js";
import { parseIntFlag, typedParseArgs } from "./shared.js";

export interface LogsFlags extends BaseFlags {
  readonly command: "logs";
  readonly manifest: string | undefined;
  readonly follow: boolean;
  readonly lines: number;
}

export function parseLogsFlags(rest: readonly string[], g: GlobalFlags): LogsFlags {
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
  return {
    command: "logs" as const,
    version: values.version ?? g.version,
    help: values.help ?? g.help,
    manifest: values.manifest ?? positionals[0],
    follow: values.follow ?? false,
    lines:
      values.lines !== undefined
        ? parseIntFlag("lines", values.lines, 1, Number.MAX_SAFE_INTEGER)
        : 50,
  };
}

export function isLogsFlags(flags: BaseFlags): flags is LogsFlags {
  return flags.command === "logs";
}
