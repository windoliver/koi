import type { BaseFlags } from "./shared.js";
import { parseIntFlag, typedParseArgs } from "./shared.js";

export interface StatusFlags extends BaseFlags {
  readonly command: "status";
  readonly manifest: string | undefined;
  readonly port: number | undefined;
  readonly timeout: number | undefined;
  readonly json: boolean;
  readonly system: boolean;
}

export function parseStatusFlags(rest: readonly string[]): StatusFlags {
  type V = {
    readonly manifest: string | undefined;
    readonly port: string | undefined;
    readonly timeout: string | undefined;
    readonly json: boolean | undefined;
    readonly system: boolean | undefined;
    readonly help: boolean | undefined;
    readonly version: boolean | undefined;
  };
  const { values, positionals } = typedParseArgs<V>(
    {
      args: rest,
      options: {
        manifest: { type: "string" },
        port: { type: "string", short: "p" },
        timeout: { type: "string" },
        json: { type: "boolean", default: false },
        system: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
        version: { type: "boolean", short: "V", default: false },
      },
      allowPositionals: true,
    },
    "status",
  );
  const helpRequested = values.help ?? false;
  const versionRequested = values.version ?? false;
  const skipValidators = helpRequested || versionRequested;
  return {
    command: "status" as const,
    version: versionRequested,
    help: helpRequested,
    manifest: values.manifest ?? positionals[0],
    port: values.port !== undefined ? parseStatusPort(values.port, skipValidators) : undefined,
    timeout:
      values.timeout !== undefined ? parseStatusTimeout(values.timeout, skipValidators) : undefined,
    json: values.json ?? false,
    system: values.system ?? false,
  };
}

function parseStatusTimeout(value: string, skip: boolean): number | undefined {
  if (skip) {
    try {
      return parseIntFlag("timeout", value, 1, Number.MAX_SAFE_INTEGER);
    } catch {
      return undefined;
    }
  }
  return parseIntFlag("timeout", value, 1, Number.MAX_SAFE_INTEGER);
}

function parseStatusPort(value: string, skip: boolean): number | undefined {
  if (skip) {
    try {
      return parseIntFlag("port", value, 1, 65_535);
    } catch {
      return undefined;
    }
  }
  return parseIntFlag("port", value, 1, 65_535);
}

export function isStatusFlags(flags: BaseFlags): flags is StatusFlags {
  return flags.command === "status";
}
