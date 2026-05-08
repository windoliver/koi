import type { BaseFlags } from "./shared.js";
import { parseIntFlag, resolveLogFormat, typedParseArgs } from "./shared.js";

export interface GatewayUpFlags extends BaseFlags {
  readonly command: "gateway-up";
  readonly port: number | undefined;
  readonly nexusUrl: string | undefined;
  readonly nexusApiKey: string | undefined;
  readonly instanceId: string | undefined;
  readonly logFormat: "text" | "json";
}

export function parseGatewayUpFlags(rest: readonly string[]): GatewayUpFlags {
  type V = {
    readonly port: string | undefined;
    readonly "nexus-url": string | undefined;
    readonly "nexus-api-key": string | undefined;
    readonly "instance-id": string | undefined;
    readonly "log-format": string | undefined;
    readonly help: boolean | undefined;
    readonly version: boolean | undefined;
  };

  const { values } = typedParseArgs<V>(
    {
      args: rest,
      options: {
        port: { type: "string" },
        "nexus-url": { type: "string" },
        "nexus-api-key": { type: "string" },
        "instance-id": { type: "string" },
        "log-format": { type: "string" },
        help: { type: "boolean", short: "h", default: false },
        version: { type: "boolean", short: "V", default: false },
      },
      allowPositionals: false,
    },
    "gateway-up",
  );

  const helpRequested = values.help ?? false;
  const versionRequested = values.version ?? false;
  const skipValidators = helpRequested || versionRequested;

  return {
    command: "gateway-up",
    help: helpRequested,
    version: versionRequested,
    port:
      values.port === undefined
        ? undefined
        : skipValidators
          ? undefined
          : parseIntFlag("port", values.port, 1, 65535),
    nexusUrl: values["nexus-url"],
    nexusApiKey: values["nexus-api-key"],
    instanceId: values["instance-id"],
    logFormat: skipValidators ? "text" : resolveLogFormat(values["log-format"]),
  };
}

export function isGatewayUpFlags(flags: BaseFlags): flags is GatewayUpFlags {
  return flags.command === "gateway-up";
}
