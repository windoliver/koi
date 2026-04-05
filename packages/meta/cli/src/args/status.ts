import type { BaseFlags, GlobalFlags } from "./shared.js";
import { parseIntFlag, typedParseArgs } from "./shared.js";

export interface StatusFlags extends BaseFlags {
  readonly command: "status";
  readonly manifest: string | undefined;
  readonly timeout: number | undefined;
  readonly json: boolean;
}

export function parseStatusFlags(rest: readonly string[], g: GlobalFlags): StatusFlags {
  type V = {
    readonly manifest: string | undefined;
    readonly timeout: string | undefined;
    readonly json: boolean | undefined;
  };
  const { values, positionals } = typedParseArgs<V>(
    {
      args: rest,
      options: {
        manifest: { type: "string" },
        timeout: { type: "string" },
        json: { type: "boolean", default: false },
      },
      allowPositionals: true,
    },
    "status",
  );
  return {
    command: "status" as const,
    version: g.version,
    help: g.help,
    manifest: values.manifest ?? positionals[0],
    timeout:
      values.timeout !== undefined
        ? parseIntFlag("timeout", values.timeout, 1, Number.MAX_SAFE_INTEGER)
        : undefined,
    json: values.json ?? false,
  };
}

export function isStatusFlags(flags: BaseFlags): flags is StatusFlags {
  return flags.command === "status";
}
