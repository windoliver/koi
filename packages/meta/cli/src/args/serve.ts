import type { BaseFlags, GlobalFlags } from "./shared.js";
import { parseIntFlag, resolveLogFormat, typedParseArgs } from "./shared.js";

export interface ServeFlags extends BaseFlags {
  readonly command: "serve";
  readonly manifest: string | undefined;
  readonly port: number | undefined;
  readonly verbose: boolean;
  readonly logFormat: "text" | "json";
}

export function parseServeFlags(rest: readonly string[], g: GlobalFlags): ServeFlags {
  type V = {
    readonly manifest: string | undefined;
    readonly port: string | undefined;
    readonly verbose: boolean | undefined;
    readonly "log-format": string | undefined;
    readonly help: boolean | undefined;
    readonly version: boolean | undefined;
  };
  const { values, positionals } = typedParseArgs<V>(
    {
      args: rest,
      options: {
        manifest: { type: "string" },
        port: { type: "string", short: "p" },
        verbose: { type: "boolean", short: "v", default: false },
        "log-format": { type: "string" },
        help: { type: "boolean", short: "h", default: false },
        version: { type: "boolean", short: "V", default: false },
      },
      allowPositionals: true,
    },
    "serve",
  );
  return {
    command: "serve" as const,
    version: values.version ?? g.version,
    help: values.help ?? g.help,
    manifest: values.manifest ?? positionals[0],
    port: values.port !== undefined ? parseIntFlag("port", values.port, 1, 65535) : undefined,
    verbose: values.verbose ?? false,
    logFormat: resolveLogFormat(values["log-format"]),
  };
}

export function isServeFlags(flags: BaseFlags): flags is ServeFlags {
  return flags.command === "serve";
}
