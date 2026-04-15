import type { BaseFlags, GlobalFlags } from "./shared.js";
import { ParseError, typedParseArgs } from "./shared.js";

export interface TuiFlags extends BaseFlags {
  readonly command: "tui";
  readonly agent: string | undefined;
  readonly session: string | undefined;
  /**
   * Session id to resume. Loads the JSONL transcript from
   * `~/.koi/sessions/<id>.jsonl` before starting the TUI so the
   * historical messages render on mount and new writes continue
   * appending to the same file. Mirrors `koi start --resume`.
   */
  readonly resume: string | undefined;
  /**
   * Path to an agent manifest (koi.yaml). When provided, the TUI
   * picks up the manifest's `modelName`, `instructions` (system
   * prompt), `stacks: [...]` opt-in, and `plugins: [...]` opt-in —
   * exactly like `koi start --manifest`. Omit for the default
   * "everything auto-discovered" behavior.
   */
  readonly manifest: string | undefined;
  readonly goal: readonly string[];
  // --- Convergence loop mode (#1624) ---
  /**
   * Verifier argv for --until-pass mode. Repeatable flag: each
   * occurrence contributes one token. Empty array disables loop mode.
   */
  readonly untilPass: readonly string[];
  /** Maximum iterations for loop mode (default 10). */
  readonly maxIter: number;
  /** Per-iteration verifier timeout in milliseconds (default 120_000). */
  readonly verifierTimeoutMs: number;
  /**
   * Acknowledges the trust-boundary implications of loop mode. Required
   * alongside --until-pass. Mirrors the single-prompt semantics in
   * `koi start`: non-idempotent tools may run on every retry, and the
   * verifier subprocess runs outside the CLI permission/sandbox system.
   */
  readonly allowSideEffects: boolean;
  /**
   * When true, the verifier subprocess inherits the parent environment
   * minus Koi provider keys. Default false (minimal allowlist only).
   */
  readonly verifierInheritEnv: boolean;
}

export function parseTuiFlags(rest: readonly string[], g: GlobalFlags): TuiFlags {
  type V = {
    readonly agent: string | undefined;
    readonly session: string | undefined;
    readonly resume: string | undefined;
    readonly manifest: string | undefined;
    readonly goal: string[] | undefined;
    readonly "until-pass": string[] | undefined;
    readonly "max-iter": string | undefined;
    readonly "verifier-timeout": string | undefined;
    readonly "allow-side-effects": boolean | undefined;
    readonly "verifier-inherit-env": boolean | undefined;
    readonly help: boolean | undefined;
    readonly version: boolean | undefined;
  };
  const { values } = typedParseArgs<V>(
    {
      args: rest,
      options: {
        agent: { type: "string" },
        session: { type: "string" },
        resume: { type: "string" },
        manifest: { type: "string" },
        goal: { type: "string", multiple: true },
        "until-pass": { type: "string", multiple: true },
        "max-iter": { type: "string" },
        "verifier-timeout": { type: "string" },
        "allow-side-effects": { type: "boolean", default: false },
        "verifier-inherit-env": { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
        version: { type: "boolean", short: "V", default: false },
      },
      allowPositionals: true,
    },
    "tui",
  );

  const helpRequested = values.help ?? false;
  const versionRequested = values.version ?? false;
  const skipValidators = helpRequested || versionRequested;

  const untilPass = values["until-pass"] ?? [];
  if (!skipValidators && untilPass.length > 0 && untilPass.some((tok) => tok.length === 0)) {
    throw new ParseError("--until-pass tokens must be non-empty");
  }

  const allowSideEffects = values["allow-side-effects"] ?? false;

  // Fail closed on unsafe combinations — mirrors koi start semantics.
  if (!skipValidators && untilPass.length > 0) {
    if (!allowSideEffects) {
      throw new ParseError(
        "--until-pass requires --allow-side-effects to explicitly acknowledge the loop's trust-boundary implications:\n" +
          "  1. The agent's full tool set (Bash, web fetch, MCP servers, hooks) is re-invoked on every retry. Any\n" +
          "     non-idempotent tool — Slack/GitHub/API calls, remote mutations, deploys — will execute once per\n" +
          "     user turn that triggers the loop. There is NO rollback between iterations.\n" +
          "  2. The verifier subprocess runs outside the CLI permission/sandbox by design. It inherits a minimal\n" +
          "     environment but can execute any code in the working directory, including code the agent just\n" +
          "     modified. This is a second execution channel not governed by hook or permission policies.\n\n" +
          "Re-run with --allow-side-effects if you understand and accept these, or omit --until-pass for normal\n" +
          "interactive TUI mode without verifier enforcement.",
      );
    }
    if (values.session !== undefined) {
      throw new ParseError(
        "--until-pass cannot be combined with --session: loop mode disables session transcript persistence, so resuming a loop run would silently drop its history. Start a fresh TUI session or omit --session",
      );
    }
    if (values.resume !== undefined) {
      throw new ParseError(
        "--until-pass cannot be combined with --resume: loop mode disables session transcript persistence, so the resumed JSONL would never see new iterations. Start a fresh TUI session or omit --resume",
      );
    }
  }

  return {
    command: "tui" as const,
    version: versionRequested,
    help: helpRequested,
    agent: values.agent,
    session: values.session,
    resume: values.resume,
    manifest: values.manifest,
    goal: values.goal ?? [],
    untilPass,
    maxIter: resolveMaxIterSafe(values["max-iter"], skipValidators),
    verifierTimeoutMs: resolveVerifierTimeoutMsSafe(values["verifier-timeout"], skipValidators),
    allowSideEffects,
    verifierInheritEnv: values["verifier-inherit-env"] ?? false,
  };
}

function resolveMaxIterSafe(raw: string | undefined, skip: boolean): number {
  if (skip) {
    try {
      return resolveMaxIter(raw);
    } catch {
      return DEFAULT_MAX_ITER;
    }
  }
  return resolveMaxIter(raw);
}

function resolveVerifierTimeoutMsSafe(raw: string | undefined, skip: boolean): number {
  if (skip) {
    try {
      return resolveVerifierTimeoutMs(raw);
    } catch {
      return DEFAULT_VERIFIER_TIMEOUT_MS;
    }
  }
  return resolveVerifierTimeoutMs(raw);
}

// Strict positive-integer regex. parseInt alone accepts trailing junk
// ("10abc" → 10) and silently discards it; the strict validator must
// reject that so a user fat-finger on a safety-critical flag doesn't
// run a different iteration count than they typed.
const POSITIVE_INT_RE = /^[1-9]\d*$/;
const DEFAULT_MAX_ITER = 10;
const DEFAULT_VERIFIER_TIMEOUT_MS = 120_000;

function resolveMaxIter(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_MAX_ITER;
  if (!POSITIVE_INT_RE.test(raw)) {
    throw new ParseError(`--max-iter must be a positive integer, got '${raw}'`);
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new ParseError(`--max-iter must be a positive integer, got '${raw}'`);
  }
  return parsed;
}

function resolveVerifierTimeoutMs(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_VERIFIER_TIMEOUT_MS;
  if (!POSITIVE_INT_RE.test(raw)) {
    throw new ParseError(
      `--verifier-timeout must be a positive integer (milliseconds), got '${raw}'`,
    );
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new ParseError(
      `--verifier-timeout must be a positive integer (milliseconds), got '${raw}'`,
    );
  }
  return parsed;
}

export function isTuiFlags(flags: BaseFlags): flags is TuiFlags {
  return flags.command === "tui";
}
