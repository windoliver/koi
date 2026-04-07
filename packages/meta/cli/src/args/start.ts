import type { BaseFlags, GlobalFlags } from "./shared.js";
import { ParseError, resolveLogFormat, typedParseArgs } from "./shared.js";

// ---------------------------------------------------------------------------
// StartMode — discriminated union: interactive REPL vs. single-prompt execution.
// Determined at parse time so commands/start.ts can switch exhaustively.
// ---------------------------------------------------------------------------

export type StartMode =
  | { readonly kind: "interactive" }
  | { readonly kind: "prompt"; readonly text: string };

export interface StartFlags extends BaseFlags {
  readonly command: "start";
  readonly manifest: string | undefined;
  readonly mode: StartMode;
  /**
   * Session ID for resume mode. Stubbed — blocked on @koi/session (#1504).
   * Parsed but always results in a KoiError("NOT_READY") at runtime.
   */
  readonly resume: string | undefined;
  readonly verbose: boolean;
  readonly dryRun: boolean;
  readonly logFormat: "text" | "json";
  /** Force raw-stdout output even when @koi/tui is available. */
  readonly noTui: boolean;
  /**
   * Maximum number of transcript messages to include in each model request.
   * Defaults to 100 (≈50 turns). Lower values reduce token costs for long sessions.
   */
  readonly contextWindow: number;
}

export function parseStartFlags(rest: readonly string[], g: GlobalFlags): StartFlags {
  type V = {
    readonly manifest: string | undefined;
    readonly prompt: string | undefined;
    readonly resume: string | undefined;
    readonly verbose: boolean | undefined;
    readonly "dry-run": boolean | undefined;
    readonly "log-format": string | undefined;
    readonly "no-tui": boolean | undefined;
    readonly "context-window": string | undefined;
  };
  const { values, positionals } = typedParseArgs<V>(
    {
      args: rest,
      options: {
        manifest: { type: "string" },
        prompt: { type: "string", short: "p" },
        resume: { type: "string" },
        verbose: { type: "boolean", short: "v", default: false },
        "dry-run": { type: "boolean", default: false },
        "log-format": { type: "string" },
        "no-tui": { type: "boolean", default: false },
        "context-window": { type: "string" },
      },
      allowPositionals: true,
    },
    "start",
  );

  const promptText = values.prompt;
  // Reject empty/whitespace-only --prompt: prevents empty shell expansions
  // (e.g. --prompt "$UNSET_VAR") from silently falling into interactive mode.
  if (promptText !== undefined && promptText.trim().length === 0) {
    throw new ParseError("--prompt value cannot be empty or whitespace-only");
  }
  const mode: StartMode =
    promptText !== undefined && promptText.length > 0
      ? { kind: "prompt", text: promptText }
      : { kind: "interactive" };

  return {
    command: "start" as const,
    version: g.version,
    help: g.help,
    manifest: values.manifest ?? positionals[0],
    mode,
    resume: values.resume,
    verbose: values.verbose ?? false,
    dryRun: values["dry-run"] ?? false,
    logFormat: resolveLogFormat(values["log-format"]),
    noTui: values["no-tui"] ?? false,
    contextWindow: resolveContextWindow(values["context-window"]),
  };
}

const DEFAULT_CONTEXT_WINDOW = 100;

/** Parse --context-window value. Returns default on invalid/missing input. */
function resolveContextWindow(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_CONTEXT_WINDOW;
  const parsed = parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_CONTEXT_WINDOW;
}

export function isStartFlags(flags: BaseFlags): flags is StartFlags {
  return flags.command === "start";
}
