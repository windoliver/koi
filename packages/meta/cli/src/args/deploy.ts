import type { BaseFlags, GlobalFlags } from "./shared.js";
import { parseIntFlag, typedParseArgs } from "./shared.js";

export interface DeployFlags extends BaseFlags {
  readonly command: "deploy";
  readonly manifest: string | undefined;
  readonly system: boolean;
  readonly uninstall: boolean;
  readonly port: number | undefined;
}

export function parseDeployFlags(rest: readonly string[], g: GlobalFlags): DeployFlags {
  type V = {
    readonly manifest: string | undefined;
    readonly system: boolean | undefined;
    readonly uninstall: boolean | undefined;
    readonly port: string | undefined;
  };
  const { values, positionals } = typedParseArgs<V>(
    {
      args: rest,
      options: {
        manifest: { type: "string" },
        system: { type: "boolean", default: false },
        uninstall: { type: "boolean", default: false },
        port: { type: "string", short: "p" },
      },
      allowPositionals: true,
    },
    "deploy",
  );
  return {
    command: "deploy" as const,
    version: g.version,
    help: g.help,
    manifest: values.manifest ?? positionals[0],
    system: values.system ?? false,
    uninstall: values.uninstall ?? false,
    port: values.port !== undefined ? parseIntFlag("port", values.port, 1, 65535) : undefined,
  };
}

export function isDeployFlags(flags: BaseFlags): flags is DeployFlags {
  return flags.command === "deploy";
}
