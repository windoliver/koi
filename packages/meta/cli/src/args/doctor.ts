import type { BaseFlags, GlobalFlags } from "./shared.js";
import { typedParseArgs } from "./shared.js";

export interface DoctorFlags extends BaseFlags {
  readonly command: "doctor";
  readonly manifest: string | undefined;
  readonly repair: boolean;
  readonly json: boolean;
}

export function parseDoctorFlags(rest: readonly string[], g: GlobalFlags): DoctorFlags {
  type V = {
    readonly manifest: string | undefined;
    readonly repair: boolean | undefined;
    readonly json: boolean | undefined;
    readonly help: boolean | undefined;
    readonly version: boolean | undefined;
  };
  const { values, positionals } = typedParseArgs<V>(
    {
      args: rest,
      options: {
        manifest: { type: "string" },
        repair: { type: "boolean", default: false },
        json: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
        version: { type: "boolean", short: "V", default: false },
      },
      allowPositionals: true,
    },
    "doctor",
  );
  return {
    command: "doctor" as const,
    version: values.version ?? g.version,
    help: values.help ?? g.help,
    manifest: values.manifest ?? positionals[0],
    repair: values.repair ?? false,
    json: values.json ?? false,
  };
}

export function isDoctorFlags(flags: BaseFlags): flags is DoctorFlags {
  return flags.command === "doctor";
}
