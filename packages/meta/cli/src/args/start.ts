import type { BaseFlags } from "./shared.js";
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
  /**
   * Convergence loop (@koi/loop #1624): argv tokens for the verifier command.
   * Repeatable flag. First occurrence is the binary, subsequent are its args.
   * Example: --until-pass bun --until-pass test --until-pass --filter=foo
   * Empty array disables loop mode (falls back to single-prompt execution).
   */
  readonly untilPass: readonly string[];
  /** Maximum iterations for --until-pass (default 10). */
  readonly maxIter: number;
  /**
   * Per-iteration verifier timeout in milliseconds for --until-pass mode.
   * Defaults to 120_000 (2 minutes). Raise this for slow integration suites
   * that legitimately take longer than 2 minutes to run.
   */
  readonly verifierTimeoutMs: number;
  /**
   * Kept as a typed field for structural compatibility with tests and
   * downstream code that still references it. The CLI surface no longer
   * exposes a `--working-dir` flag for loop mode: rooting the agent and
   * the verifier at a directory other than `process.cwd()` would require
   * plumbing workingDir through MCP providers, static providers, hook
   * loading, and session storage — a larger refactor than Phase A
   * scopes. Until that rerooting work lands, loop mode runs in the
   * shell's current directory and users who need a different subtree
   * should `cd` before invoking koi.
   */
  readonly workingDir: undefined;
  /**
   * Acknowledges two trust-boundary implications of loop mode:
   *
   *   1. The agent's full tool set is re-invoked on every retry. Any
   *      non-idempotent tool (Slack/GitHub/API calls, MCP remote actions,
   *      Bash commands that mutate state) will run once per iteration.
   *      There is NO rollback between attempts.
   *
   *   2. The verifier subprocess runs outside the CLI permission/sandbox
   *      system by design. It inherits only a minimal env by default,
   *      but it can execute any code in `workingDir` — including code
   *      the agent just modified. This gives the loop a second execution
   *      channel that is not governed by --permission-mode or hook
   *      policies.
   *
   * Required for loop mode. Fails closed until the user explicitly
   * opts in.
   */
  readonly allowSideEffects: boolean;
  /**
   * When true, forward the parent process env (minus Koi provider keys)
   * to the verifier subprocess. When false (default), the verifier gets
   * only a minimal allowlist (PATH, HOME, USER, LANG, TERM, TMPDIR).
   *
   * Secure-by-default: project secrets like DATABASE_URL, GITHUB_TOKEN,
   * AWS_ACCESS_KEY_ID, NEXTAUTH_SECRET, etc. do not reach verifier code
   * the agent may have just modified unless the user explicitly opts in.
   *
   * Test suites that genuinely need project env vars must opt in. The
   * alternative — strict substring-based secret stripping — broke real
   * test suites in round 8, so the knob is exposed as a user decision
   * rather than a heuristic scanner.
   */
  readonly verifierInheritEnv: boolean;
}

export function parseStartFlags(rest: readonly string[]): StartFlags {
  type V = {
    readonly manifest: string | undefined;
    readonly prompt: string | undefined;
    readonly resume: string | undefined;
    readonly verbose: boolean | undefined;
    readonly "dry-run": boolean | undefined;
    readonly "log-format": string | undefined;
    readonly "no-tui": boolean | undefined;
    readonly "context-window": string | undefined;
    readonly "until-pass": string[] | undefined;
    readonly "max-iter": string | undefined;
    readonly "verifier-timeout": string | undefined;
    readonly "allow-side-effects": boolean | undefined;
    readonly "verifier-inherit-env": boolean | undefined;
    readonly help: boolean | undefined;
    readonly version: boolean | undefined;
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
    "start",
  );

  // Help/version is an escape hatch: when set, all semantic validators
  // that would throw on bad values or unsafe combinations are skipped.
  // The parser still returns the user's actual parsed values — no
  // fabricated defaults, no discarded fields — so external callers of
  // parseStartFlags see a faithful representation of the invocation.
  const helpRequested = values.help ?? false;
  const versionRequested = values.version ?? false;
  const skipValidators = helpRequested || versionRequested;

  const untilPass = values["until-pass"] ?? [];
  if (!skipValidators && untilPass.length > 0 && untilPass.some((tok) => tok.length === 0)) {
    throw new ParseError("--until-pass tokens must be non-empty");
  }

  const promptText = values.prompt;
  // Reject empty/whitespace-only --prompt: prevents empty shell expansions
  // (e.g. --prompt "$UNSET_VAR") from silently falling into interactive mode.
  if (!skipValidators && promptText !== undefined && promptText.trim().length === 0) {
    throw new ParseError("--prompt value cannot be empty or whitespace-only");
  }
  const mode: StartMode =
    promptText !== undefined && promptText.length > 0
      ? { kind: "prompt", text: promptText }
      : { kind: "interactive" };

  const allowSideEffects = values["allow-side-effects"] ?? false;

  // Fail closed on unsafe combinations — --until-pass is a safety flag.
  // Running it silently without a verifier-enforced prompt, or combining it
  // with --resume (which expects persistent session state we don't write in
  // loop mode), would both violate user expectations.
  if (!skipValidators && untilPass.length > 0) {
    if (mode.kind !== "prompt") {
      throw new ParseError(
        "--until-pass requires --prompt: convergence loop mode runs a single prompt with verifier enforcement, and there is no interactive-loop mode yet",
      );
    }
    if (values.resume !== undefined) {
      throw new ParseError(
        "--until-pass cannot be combined with --resume: loop mode does not write to the session transcript, so resuming a loop run would silently drop its history. Run the loop in a fresh session, or omit --resume",
      );
    }
    if (!allowSideEffects) {
      throw new ParseError(
        "--until-pass requires --allow-side-effects to explicitly acknowledge the loop's trust-boundary implications:\n" +
          "  1. The agent's full tool set (Bash, web fetch, MCP servers, hooks) is re-invoked on every retry. Any\n" +
          "     non-idempotent tool — Slack/GitHub/API calls, remote mutations, deploys — will execute once per\n" +
          "     iteration. There is NO rollback between attempts.\n" +
          "  2. The verifier subprocess runs outside the CLI permission/sandbox by design. It inherits a scrubbed\n" +
          "     environment but can execute any code in the working directory, including code the agent just\n" +
          "     modified. This is a second execution channel not governed by --permission-mode or hook policies.\n\n" +
          "Re-run with --allow-side-effects if you understand and accept these, or switch to single-prompt mode\n" +
          "without --until-pass for one-shot execution under the normal permission model.",
      );
    }
    // Loop mode bypasses the harness and writes human-readable banners
    // + verifier status lines directly to stdout. That breaks the
    // --log-format json contract: callers relying on structured output
    // would get a mixed stream of JSON events and plain-text loop
    // decorations. Reject the combination at parse time until structured
    // loop events are plumbed through a shared renderer.
    if (resolveLogFormatOrDefault(values["log-format"], skipValidators) === "json") {
      throw new ParseError(
        "--until-pass cannot be combined with --log-format json: loop mode writes human-readable iteration banners and verifier status lines directly to stdout, which would produce a mixed stream that breaks JSON parsing. Omit --log-format json (or switch to single-prompt mode) until structured loop events are implemented",
      );
    }
  }

  return {
    command: "start" as const,
    version: versionRequested,
    help: helpRequested,
    manifest: values.manifest ?? positionals[0],
    mode,
    resume: values.resume,
    verbose: values.verbose ?? false,
    dryRun: values["dry-run"] ?? false,
    logFormat: resolveLogFormatOrDefault(values["log-format"], skipValidators),
    noTui: values["no-tui"] ?? false,
    contextWindow: resolveContextWindow(values["context-window"]),
    untilPass,
    maxIter: resolveMaxIterOrDefault(values["max-iter"], skipValidators),
    verifierTimeoutMs: resolveVerifierTimeoutMsOrDefault(
      values["verifier-timeout"],
      skipValidators,
    ),
    workingDir: undefined,
    allowSideEffects,
    verifierInheritEnv: values["verifier-inherit-env"] ?? false,
  };
}

function resolveLogFormatOrDefault(raw: string | undefined, skip: boolean): "text" | "json" {
  if (skip) {
    try {
      return resolveLogFormat(raw);
    } catch {
      return "text";
    }
  }
  return resolveLogFormat(raw);
}

function resolveMaxIterOrDefault(raw: string | undefined, skip: boolean): number {
  if (skip) {
    try {
      return resolveMaxIter(raw);
    } catch {
      return DEFAULT_MAX_ITER;
    }
  }
  return resolveMaxIter(raw);
}

function resolveVerifierTimeoutMsOrDefault(raw: string | undefined, skip: boolean): number {
  if (skip) {
    try {
      return resolveVerifierTimeoutMs(raw);
    } catch {
      return DEFAULT_VERIFIER_TIMEOUT_MS;
    }
  }
  return resolveVerifierTimeoutMs(raw);
}

const DEFAULT_MAX_ITER = 10;
const DEFAULT_VERIFIER_TIMEOUT_MS = 120_000;

// Strict non-negative integer regex. parseInt alone accepts trailing
// junk ("10abc" → 10) and silently discards it, which would let a
// user fat-finger a safety-critical flag and get a different value
// than they typed. Require the entire string to be digits.
const POSITIVE_INT_RE = /^[1-9]\d*$/;

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
