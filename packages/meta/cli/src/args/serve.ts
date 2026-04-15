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
  const helpRequested = values.help ?? g.help;
  const versionRequested = values.version ?? g.version;
  const skipValidators = helpRequested || versionRequested;

  return {
    command: "serve" as const,
    version: versionRequested,
    help: helpRequested,
    manifest: values.manifest ?? positionals[0],
    port:
      values.port !== undefined
        ? parseIntFlagOrUndefined("port", values.port, 1, 65535, skipValidators)
        : undefined,
    verbose: values.verbose ?? false,
    logFormat: resolveLogFormatOrText(values["log-format"], skipValidators),
  };
}

function parseIntFlagOrUndefined(
  name: string,
  value: string,
  min: number,
  max: number,
  skip: boolean,
): number | undefined {
  if (skip) {
    try {
      return parseIntFlag(name, value, min, max);
    } catch {
      return undefined;
    }
  }
  return parseIntFlag(name, value, min, max);
}

function resolveLogFormatOrText(raw: string | undefined, skip: boolean): "text" | "json" {
  if (skip) {
    try {
      return resolveLogFormat(raw);
    } catch {
      return "text";
    }
  }
  return resolveLogFormat(raw);
}

export function isServeFlags(flags: BaseFlags): flags is ServeFlags {
  return flags.command === "serve";
}
