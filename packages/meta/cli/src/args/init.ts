import type { BaseFlags, GlobalFlags } from "./shared.js";
import { typedParseArgs } from "./shared.js";

export interface InitFlags extends BaseFlags {
  readonly command: "init";
  readonly directory: string | undefined;
  readonly yes: boolean;
  readonly name: string | undefined;
  readonly template: string | undefined;
  readonly model: string | undefined;
  readonly engine: string | undefined;
}

export function parseInitFlags(rest: readonly string[], g: GlobalFlags): InitFlags {
  type V = {
    readonly yes: boolean | undefined;
    readonly name: string | undefined;
    readonly template: string | undefined;
    readonly model: string | undefined;
    readonly engine: string | undefined;
  };
  const { values, positionals } = typedParseArgs<V>(
    {
      args: rest,
      options: {
        yes: { type: "boolean", short: "y", default: false },
        name: { type: "string" },
        template: { type: "string" },
        model: { type: "string" },
        engine: { type: "string" },
      },
      allowPositionals: true,
    },
    "init",
  );
  return {
    command: "init" as const,
    directory: positionals[0],
    version: g.version,
    help: g.help,
    yes: values.yes ?? false,
    name: values.name,
    template: values.template,
    model: values.model,
    engine: values.engine,
  };
}

export function isInitFlags(flags: BaseFlags): flags is InitFlags {
  return flags.command === "init";
}
