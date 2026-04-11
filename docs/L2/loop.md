# @koi/loop

**Layer:** L2
**Location:** `packages/lib/loop/`
**Purpose:** Convergence loop primitive — re-runs an agent against a deterministic verifier (tests, lints, type-check, file checks, custom predicates) until the verifier passes or a budget is exhausted.

## Why It Exists

Self-correcting iteration against deterministic feedback is the dominant pattern that distinguishes useful agents from suggestion engines. Users expect "keep going until tests pass" as a baseline capability. Without an explicit loop primitive, every user reinvents this with hooks or shell wrappers, all subtly broken.

`@koi/loop` provides a single, narrow primitive (`runUntilPass`) that:

- Runs an agent turn, then an external verifier, then decides to stop or retry
- Enforces iteration count, token budget, and per-iteration timeouts
- Trips a circuit breaker after too many consecutive failures
- Aborts cleanly on external signal or timeout
- Emits typed events for observability

It is a **single-goal** primitive. Multi-item PRD mode (from the v1 archive) is explicitly out of scope and will ship as a separate function if and when demand justifies it.

## What This Enables

```
┌─────────────┐   initialPrompt    ┌───────────┐
│   caller    │───────────────────▶│           │
└─────────────┘                    │           │
       ▲                           │ runUntil  │
       │   RunUntilPassResult      │   Pass    │
       │                           │           │
       └───────────────────────────│           │
                                   └─────┬─────┘
                                         │
                       ┌─────────────────┼─────────────────┐
                       ▼                 ▼                 ▼
              ┌─────────────┐  ┌─────────────┐  ┌──────────────┐
              │ LoopRuntime │  │  Verifier   │  │ rebuildPrompt│
              │  (user)     │  │  (user)     │  │  (optional)  │
              └─────────────┘  └─────────────┘  └──────────────┘
                                     │
                         ┌───────────┴──────────┐
                         ▼                      ▼
                  ┌────────────┐         ┌────────────┐
                  │ createArgv │         │ createFile │
                  │   Gate     │         │   Gate     │
                  └────────────┘         └────────────┘
```

## Public API

```typescript
import type { EngineEvent } from "@koi/core";

/**
 * Structural runtime interface. Does NOT import @koi/engine (L1).
 * Any caller that can produce an EngineEvent stream from a text prompt
 * plugs in here — the harness, a test fake, a cassette replayer, etc.
 */
export interface LoopRuntime {
  readonly run: (input: {
    readonly kind: "text";
    readonly text: string;
    readonly signal?: AbortSignal;
  }) => AsyncIterable<EngineEvent>;
}

// ── Verifier ──────────────────────────────────────────────────────────────

export type VerifierFailureReason =
  | "exit_nonzero"       // process ran, exited with non-0
  | "spawn_error"        // process couldn't start (ENOENT, permission)
  | "timeout"            // verifier hit verifierTimeoutMs
  | "aborted"            // external abort signal fired during verification
  | "predicate_threw"    // a non-argv gate threw an exception
  | "file_missing"       // createFileGate: path didn't exist
  | "file_no_match"      // createFileGate: content didn't match
  | "runtime_error"      // iteration failed before the verifier ran (no done event, timeout, cleanup failure, etc.) — the IterationRecord.runtimeError field carries the actual message
  | "skipped_budget_exhausted"; // iteration completed successfully but the verifier was skipped because the cumulative token budget hit the cap after this iteration's spend — the loop terminated as exhausted without running the verifier to avoid extra side effects after the stop condition

export type VerifierResult =
  | { readonly ok: true; readonly details?: string }
  | {
      readonly ok: false;
      readonly reason: VerifierFailureReason;
      readonly details: string;      // human-readable, truncated to 2 KB
      readonly exitCode?: number;    // populated for argv gate failures
    };

export interface VerifierContext {
  readonly iteration: number;
  readonly workingDir: string;
  readonly signal: AbortSignal;
}

export interface Verifier {
  readonly check: (ctx: VerifierContext) => Promise<VerifierResult>;
}

// ── Config ────────────────────────────────────────────────────────────────

export interface RunUntilPassConfig {
  readonly runtime: LoopRuntime;
  readonly verifier: Verifier;
  readonly initialPrompt: string;

  /** REQUIRED — no silent process.cwd() default. */
  readonly workingDir: string;

  /** Build the re-prompt for iteration N+1. Default sanitizes + truncates. */
  readonly rebuildPrompt?: (ctx: RebuildPromptContext) => string;

  readonly maxIterations?: number;                      // default 10
  readonly maxBudgetTokens?: number | "unmetered";      // default "unmetered"
  readonly iterationTimeoutMs?: number;                 // default 10 * 60_000
  readonly verifierTimeoutMs?: number;                  // default 2 * 60_000
  readonly maxConsecutiveFailures?: number;             // default 3

  readonly signal?: AbortSignal;
  readonly onEvent?: (event: LoopEvent) => void;
}

export interface RebuildPromptContext {
  readonly iteration: number;                      // next iteration number (2..N)
  readonly initialPrompt: string;
  readonly latestFailure: VerifierResult;          // always ok:false here
  /** Last 3 failures, each truncated to 2 KB. */
  readonly recentFailures: readonly VerifierResult[];
  readonly tokensConsumed: number | "unmetered";
}

// ── Result & events ───────────────────────────────────────────────────────

export type LoopStatus =
  | "converged"
  | "exhausted"          // maxIterations or maxBudgetTokens reached
  | "aborted"            // external signal fired
  | "circuit_broken"     // maxConsecutiveFailures reached
  | "errored";           // runtime.run produced no events / no done event

export interface IterationRecord {
  readonly iteration: number;
  readonly durationMs: number;
  readonly tokensConsumed: number | "unmetered";
  readonly verifierResult: VerifierResult;
  readonly runtimeError?: string;
}

export interface RunUntilPassResult {
  readonly status: LoopStatus;
  readonly iterations: number;
  readonly tokensConsumed: number | "unmetered";
  readonly durationMs: number;
  readonly iterationRecords: readonly IterationRecord[];
  readonly terminalReason: string;
}

export type LoopEvent =
  | { readonly kind: "loop.iteration.start"; readonly iteration: number; readonly prompt: string }
  | { readonly kind: "loop.iteration.complete"; readonly record: IterationRecord }
  | { readonly kind: "loop.verifier.start"; readonly iteration: number }
  | { readonly kind: "loop.verifier.complete"; readonly iteration: number; readonly result: VerifierResult }
  | { readonly kind: "loop.terminal"; readonly result: RunUntilPassResult };

// ── Entry points ──────────────────────────────────────────────────────────

export function runUntilPass(config: RunUntilPassConfig): Promise<RunUntilPassResult>;

// ── Gates ─────────────────────────────────────────────────────────────────

export function createArgvGate(
  argv: readonly [string, ...string[]],
  options?: {
    readonly cwd?: string;
    readonly env?: Readonly<Record<string, string>>;
    readonly timeoutMs?: number;
    readonly stderrBytes?: number;
  },
): Verifier;

export function createFileGate(
  path: string,
  match: string | RegExp,
): Verifier;

export function createCompositeGate(gates: readonly Verifier[]): Verifier;
```

## Usage Examples

### Minimal — run an agent until `bun test` passes

```typescript
import { createArgvGate, runUntilPass } from "@koi/loop";

const result = await runUntilPass({
  runtime,                                            // your KoiRuntime-like object
  verifier: createArgvGate(["bun", "test"]),
  initialPrompt: "Fix the failing test in foo.test.ts",
  workingDir: "/path/to/project",
  maxIterations: 5,
});

if (result.status === "converged") {
  console.log(`Passed after ${result.iterations} iterations`);
} else {
  console.error(`Loop ended: ${result.status} — ${result.terminalReason}`);
}
```

### Composite gate — typecheck then test

```typescript
import { createArgvGate, createCompositeGate, runUntilPass } from "@koi/loop";

await runUntilPass({
  runtime,
  verifier: createCompositeGate([
    createArgvGate(["bun", "run", "typecheck"]),
    createArgvGate(["bun", "test"]),
  ]),
  initialPrompt: "Fix types and tests",
  workingDir: process.env.PROJECT_ROOT ?? "./",
  maxBudgetTokens: 500_000,
});
```

### Custom rebuilder — branch on failure reason

```typescript
await runUntilPass({
  runtime,
  verifier: createArgvGate(["bun", "test"]),
  initialPrompt: "Make the tests pass",
  workingDir: "./",
  rebuildPrompt: ({ latestFailure, initialPrompt, iteration }) => {
    if (!latestFailure.ok && latestFailure.reason === "timeout") {
      return `${initialPrompt}\n\nPrevious attempt (iter ${iteration - 1}) timed out. Simplify.`;
    }
    return `${initialPrompt}\n\nFailure:\n${latestFailure.ok ? "" : latestFailure.details}`;
  },
});
```

## Architecture

### Terminal state machine

The loop is modelled as an explicit state machine with exactly five terminal states:

```
idle → iterating → verifying → (converged | iterating)
                            ↘ (exhausted | circuit_broken | aborted)
       ↘ (errored — runtime produced no events or no done)
```

Every terminal transition emits `loop.terminal` exactly once. The `RunUntilPassResult` returned by `runUntilPass()` is the same payload carried in that event.

### Budget model

Token budget is **cumulative post-iteration**. Each iteration's consumption comes from `EngineEvent.done`'s `EngineOutput.metrics.totalTokens`. After an iteration completes, the loop sums the running total and, if `maxBudgetTokens` is set, terminates with `exhausted` if the total is at or above the cap.

Two explicit modes:

| `maxBudgetTokens` | Behavior |
|---|---|
| `"unmetered"` (default) | Loop does not count tokens. `tokensConsumed` in the result is literal `"unmetered"`. Iteration and time budgets are the only active constraints. |
| `number` (hard cap) | Loop counts tokens from every iteration's `done` event. Terminates with `status: "exhausted"` when total ≥ cap. **Fails closed on the first unmetered iteration**: if any iteration reports no token usage (adapter didn't populate `EngineOutput.metrics.totalTokens`, or the stream had no done event), the loop terminates with `status: "errored"` rather than silently dropping that iteration from the accounting. Rationale: silently skipping unmetered iterations would let an adapter with intermittent usage reporting exceed the cap, violating the hard-cap promise. |

**Compatibility note:** Adapters that do not populate `EngineOutput.metrics.totalTokens` (test fakes, replay cassettes, custom adapters) cannot be used with a numeric `maxBudgetTokens`. Use `"unmetered"` (the default) for those. To enforce spend caps on an unmetered adapter, wrap it with a middleware that injects metrics, or use iteration and time budgets instead.

There is no pre-iteration estimate/reserve — adapters can't predict future usage without running the request.

### Circuit breaker

Pure consecutive-failure counter, ported from v1. On every verifier failure, increment. When the count reaches `maxConsecutiveFailures` (default 3), the loop terminates with `circuit_broken`. The counter is **not** text-aware — it does not compare failure messages. If the agent produces three failures in a row (even with different messages), the loop stops.

### Verifier command model — argv only

Gates take `readonly [string, ...string[]]` (non-empty argv). There is no shell-string API. Reasons:

- Shell strings require quoting rules that vary by shell; `cmd.split(" ")` is wrong for any non-trivial command.
- Shell mode is an injection surface.
- Environment inheritance is opaque.

If you need `bun typecheck && bun test`, use `createCompositeGate([...])`. It runs each gate in order and stops at the first failure.

### CLI: passing verifier flags through `--until-pass`

The `--until-pass` flag is repeatable — each occurrence contributes one argv token. This means verifier commands with their own flags are expressed as a sequence of `--until-pass` invocations:

```bash
# bun test with a --filter argument
koi start -p "fix the test" \
  --until-pass bun \
  --until-pass test \
  --until-pass --filter=foo \
  --allow-side-effects

# pytest with multiple flags
koi start -p "fix the failing test" \
  --until-pass pytest \
  --until-pass -xvs \
  --until-pass --timeout=30 \
  --allow-side-effects
```

**Dash-prefixed argv tokens work:** Koi's CLI parser runs Node's `parseArgs` in non-strict mode, so `--until-pass --filter=foo` is accepted and captured as the string `--filter=foo`. For tokens that start with a single dash (like `-xvs`), the same rule applies.

If the `--until-pass` sequence collides with another CLI flag you actually want to pass, use the `=` form: `--until-pass=--timeout` binds the value to the flag explicitly and removes ambiguity.

For multi-step verification (`typecheck && test`), build a composite gate programmatically instead of trying to express it in a single `--until-pass` invocation — see the composite gate example above.

### Zero-event / no-`done` handling

If `runtime.run()` yields zero events, or ends without a `done` event, the iteration terminates the loop with status `errored`. The verifier is **not** called — this isolates runtime bugs from verifier bugs. This mirrors `packages/lib/harness/src/harness.ts` where a missing `done` event is also treated as a hard error.

### Prompt rebuilding — sanitized, truncated, bounded

The default `rebuildPrompt`:

- Embeds only the **latest** failure (not full history)
- Strips ANSI escape sequences
- Redacts non-printable control characters
- Truncates `details` to 2 KB

Custom rebuilders receive `recentFailures` (the last 3, each already truncated) so they can include history deliberately. This bounds prompt growth: 10 iterations of default rebuilds cost ~20 KB of prompt overhead, not runaway context.

### Abort semantics

`signal` propagates to both the in-flight `runtime.run()` and the verifier. The verifier and runtime never run concurrently — verifier starts only after the iteration stream ends. Internally, `AbortSignal.any([externalSignal, iterationTimeout])` is used for the iteration phase and a fresh `AbortSignal.any([externalSignal, verifierTimeout])` for the verifier phase. On abort, the loop drains any in-flight async iterable and returns with `status: "aborted"`.

## Dependencies

- `@koi/core` (L0) — `EngineEvent`, `EngineOutput` types
- `@koi/errors` (L0u) — `extractMessage` utility, `KoiError` shape
- `@koi/validation` (L0u) — config validation helpers

## Security Notes

- Gates spawn subprocesses under the same permission system as any other subprocess — they do not bypass `@koi/bash-security`. If your runtime enforces a tool sandbox, that sandbox also applies to the process that calls `runUntilPass`.
- `workingDir` is required. There is no silent `process.cwd()` fallback. Callers must be explicit about where verifiers run.
- Prompt rebuilders strip ANSI and control characters to prevent a crashing verifier from smuggling terminal control codes back through the LLM prompt. They also redact common credential patterns (API keys, JWTs, bearer tokens, basic-auth URLs, `password=`/`secret=` assignments) before verifier output reaches retry prompts.
- **`createArgvGate` is secure-by-default for env.** When the caller omits both `env` and `inheritEnv`, the subprocess gets only a minimal allowlist: PATH, HOME, USER, LOGNAME, LANG, LC_*, TERM, TMPDIR, TEMP, TMP, SHELL (tooling/locale/scratch-space) plus NODE_ENV, CI, DEBUG, FORCE_COLOR, NO_COLOR (test-framework mode signals — not secrets). To forward the full parent env, pass `inheritEnv: true` explicitly — that's a deliberate acknowledgment that provider keys and project secrets will reach the verifier. To pass a custom env, supply `env: {...}` directly (takes precedence over both defaults).
- **`koi start --until-pass` mirrors the library default.** Loop mode uses the minimal allowlist by default. Users whose test suites need project env vars (NEXTAUTH_SECRET, DB_PASSWORD, STRIPE_SECRET_KEY, etc.) must opt in explicitly with `--verifier-inherit-env`. That flag forwards the parent env with only Koi's own provider keys (OPENROUTER_API_KEY, OPENAI_API_KEY, ANTHROPIC_API_KEY, GOOGLE_API_KEY, GEMINI_API_KEY) scrubbed. The opt-in surfaces the trade-off: project secrets will reach any code the agent may have just modified, on every retry.

## Non-Goals

- **Multi-item PRD mode.** Separate function, separate design, separate issue if and when demand justifies it. Do not grow `runUntilPass` to support it.
- **Cost routing / per-iteration model selection.** Separate issue.
- **TUI rendering of loop events.** Lives in `@koi/tui`, not here. This package only emits typed events.
- **Interactive + until-pass.** Single-prompt mode only. Interactive REPL + convergence loop is a distinct UX problem.
