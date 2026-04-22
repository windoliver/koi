import type { BaseFlags } from "./shared.js";
import { typedParseArgs } from "./shared.js";

export interface DreamFlags extends BaseFlags {
  readonly command: "dream";
  readonly memoryDir: string | undefined;
  readonly model: string | undefined;
  readonly modelUrl: string | undefined;
  readonly force: boolean;
  readonly json: boolean;
}

export function parseDreamFlags(rest: readonly string[]): DreamFlags {
  type V = {
    readonly "memory-dir": string | undefined;
    readonly model: string | undefined;
    readonly "model-url": string | undefined;
    readonly force: boolean | undefined;
    readonly json: boolean | undefined;
    readonly help: boolean | undefined;
    readonly version: boolean | undefined;
  };
  const { values } = typedParseArgs<V>(
    {
      args: rest,
      options: {
        "memory-dir": { type: "string" },
        model: { type: "string" },
        "model-url": { type: "string" },
        force: { type: "boolean", default: false },
        json: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
        version: { type: "boolean", short: "V", default: false },
      },
      allowPositionals: false,
    },
    "dream",
  );
  return {
    command: "dream" as const,
    version: values.version ?? false,
    help: values.help ?? false,
    memoryDir: values["memory-dir"],
    model: values.model,
    modelUrl: values["model-url"],
    force: values.force ?? false,
    json: values.json ?? false,
  };
}

export function isDreamFlags(flags: BaseFlags): flags is DreamFlags {
  return flags.command === "dream";
}
