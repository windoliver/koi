import type { BaseFlags } from "./shared.js";
import { ParseError, typedParseArgs } from "./shared.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type BgSubcommand = "ps" | "logs" | "kill" | "attach" | "detach";

const VALID_SUBCOMMANDS: ReadonlySet<string> = new Set(["ps", "logs", "kill", "attach", "detach"]);

// `detach` is intentionally omitted: the subprocess backend has no
// detachable session and `runDetach` is a stateless explanatory stub.
// Requiring a worker id for a subcommand that doesn't consume one is
// user-hostile, so `detach` accepts zero positionals. Tmux backend
// (3b-6) owns the real attached-pty flow.
const REQUIRES_ID: ReadonlySet<BgSubcommand> = new Set(["logs", "kill", "attach"]);

export interface BgFlags extends BaseFlags {
  readonly command: "bg";
  /** Undefined when `help` or `version` is set — see `McpFlags.subcommand`. */
  readonly subcommand: BgSubcommand | undefined;
  /** Worker id — required for all subs except `ps`. */
  readonly workerId: string | undefined;
  /** `--follow` for `logs`: keep tailing after printing existing content. */
  readonly follow: boolean;
  /** `--json` output for `ps`. */
  readonly json: boolean;
  /** Override the default registry directory (defaults to `$KOI_STATE_DIR/daemon/sessions`). */
  readonly registryDir: string | undefined;
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

export function parseBgFlags(rest: readonly string[]): BgFlags {
  type V = {
    readonly follow: boolean | undefined;
    readonly json: boolean | undefined;
    readonly "registry-dir": string | undefined;
    readonly help: boolean | undefined;
    readonly version: boolean | undefined;
  };
  const { values, positionals } = typedParseArgs<V>(
    {
      args: rest,
      options: {
        follow: { type: "boolean", short: "f", default: false },
        json: { type: "boolean", default: false },
        "registry-dir": { type: "string" },
        help: { type: "boolean", short: "h", default: false },
        version: { type: "boolean", short: "V", default: false },
      },
      allowPositionals: true,
    },
    "bg",
  );

  const helpRequested = values.help ?? false;
  const versionRequested = values.version ?? false;
  const sub = positionals[0];
  const workerId = positionals[1];

  if (!helpRequested && !versionRequested) {
    if (sub === undefined || !VALID_SUBCOMMANDS.has(sub)) {
      throw new ParseError(`koi bg requires a subcommand: ${[...VALID_SUBCOMMANDS].join(", ")}`);
    }
    if (REQUIRES_ID.has(sub as BgSubcommand) && workerId === undefined) {
      throw new ParseError(`koi bg ${sub} requires a worker id`);
    }
  }

  const subcommand: BgSubcommand | undefined =
    sub !== undefined && VALID_SUBCOMMANDS.has(sub) ? (sub as BgSubcommand) : undefined;

  return {
    command: "bg" as const,
    version: versionRequested,
    help: helpRequested,
    subcommand,
    workerId,
    follow: values.follow ?? false,
    json: values.json ?? false,
    registryDir: values["registry-dir"],
  };
}

// ---------------------------------------------------------------------------
// Type guard
// ---------------------------------------------------------------------------

export function isBgFlags(flags: BaseFlags): flags is BgFlags {
  return flags.command === "bg";
}
