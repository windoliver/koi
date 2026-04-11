# Issue #1624 — `@koi/loop`: test-until-pass convergence loop

**Branch:** `worktree-loop-until-pass-1624`
**Issue:** [#1624](https://github.com/windoliver/koi/issues/1624) (P1, phase-2, L2)
**Layer:** L2 (new package `@koi/loop`)
**Reference:** `archive/v1/packages/sched/verified-loop` (v1 port)

> **Revision history**
> - v1 draft: initial Phase A/B split, exact-string circuit breaker, `cmd.split(" ")` CLI binding, cassette-only golden query.
> - v2 draft (this file): rewritten after Codex adversarial review. See [section 10](#10-adversarial-review-response) for how each finding was addressed.

---

## 1. Goal

Add a first-class **convergence loop primitive** that re-runs an agent with failure output until a deterministic verifier (exit 0) passes or an iteration/token budget is exhausted.

Scope of this PR: **single-goal mode only** (`runUntilPass`). Multi-item PRD mode is **not promised as additive** — it is a separate future design that may require breaking changes. See [section 8](#8-phase-scope-and-non-promises).

## 2. Design summary

```
┌─────────────── @koi/loop (L2) ───────────────┐
│                                              │
│  runUntilPass(config)  ◄── the issue's ask   │
│    └─ iterates runtime.run(prompt) until     │
│       verifier passes OR budget exhausted    │
│    └─ single goal, single verifier, single   │
│       workingDir — intentionally narrow      │
│                                              │
│  argv-only gates:                            │
│    createArgvGate(argv, opts)  ◄── no shell  │
│    createFileGate(path, match)               │
│    createCompositeGate([...])                │
│                                              │
│  events: LoopEvent discriminated union       │
│  state machine: idle → iterating → verifying │
│    → converged | exhausted | aborted         │
│    | circuit_broken | errored                │
└──────────────────────────────────────────────┘
           │
           │ depends on (L0 only)
           ▼
   @koi/core, @koi/errors (L0u), @koi/validation (L0u)
```

### 2.1 Public API

```typescript
// @koi/loop — public surface

/** Structural interface — does NOT import @koi/engine (L1). */
export interface LoopRuntime {
  readonly run: (input: {
    readonly kind: "text";
    readonly text: string;
    readonly signal?: AbortSignal;
  }) => AsyncIterable<EngineEvent>;
}

/** Verifier result is a typed discriminated union — failure modes never collapse. */
export type VerifierResult =
  | { readonly ok: true; readonly details?: string }
  | {
      readonly ok: false;
      readonly reason: VerifierFailureReason;
      readonly details: string;      // human-readable message, truncated to 2KB
      readonly exitCode?: number;    // present for argv gate failures
    };

export type VerifierFailureReason =
  | "exit_nonzero"       // process ran, exited with non-0
  | "spawn_error"        // process couldn't start (ENOENT, permission)
  | "timeout"            // verifier hit verifierTimeoutMs
  | "aborted"            // external abort signal fired during verification
  | "predicate_threw"    // a non-argv gate threw an exception
  | "file_missing"       // createFileGate: path didn't exist
  | "file_no_match";     // createFileGate: content didn't match

export interface Verifier {
  readonly check: (ctx: VerifierContext) => Promise<VerifierResult>;
}

export interface VerifierContext {
  readonly iteration: number;
  readonly workingDir: string;   // required, never defaulted to process.cwd() by the loop
  readonly signal: AbortSignal;
}

export interface RunUntilPassConfig {
  readonly runtime: LoopRuntime;
  readonly verifier: Verifier;
  readonly initialPrompt: string;

  /** REQUIRED — no silent process.cwd() default. */
  readonly workingDir: string;

  /** Build the re-prompt for iteration N+1 given the failure. */
  readonly rebuildPrompt?: (ctx: RebuildPromptContext) => string;

  // ---- Budgets & safety ----
  readonly maxIterations?: number;            // default 10
  readonly maxBudgetTokens?: number | "unmetered";  // default "unmetered"
  readonly iterationTimeoutMs?: number;       // default 10 * 60_000
  readonly verifierTimeoutMs?: number;        // default 2 * 60_000

  /**
   * Circuit breaker: after this many *consecutive* verifier failures, stop and
   * return circuit_broken. Mirrors v1 — a pure failure counter, NOT text
   * equality. Resets to 0 on any convergence (not reachable in single-goal
   * mode but kept for semantic consistency with v1).
   */
  readonly maxConsecutiveFailures?: number;   // default 3

  readonly signal?: AbortSignal;
  readonly onEvent?: (event: LoopEvent) => void;
}

export interface RebuildPromptContext {
  readonly iteration: number;              // next iteration number (2..N)
  readonly initialPrompt: string;
  readonly latestFailure: VerifierResult;  // always ok:false here
  /** Truncated to last 3 failures, each redacted to 4KB max. */
  readonly recentFailures: readonly VerifierResult[];
  readonly tokensConsumed: number | "unmetered";
}

/** Terminal state is one of exactly these 5 values. */
export type LoopStatus =
  | "converged"
  | "exhausted"          // maxIterations or maxBudgetTokens hit
  | "aborted"            // external signal fired
  | "circuit_broken"     // maxConsecutiveFailures hit
  | "errored";           // runtime.run produced no events / no done event

export interface RunUntilPassResult {
  readonly status: LoopStatus;
  readonly iterations: number;
  readonly tokensConsumed: number | "unmetered";
  readonly durationMs: number;
  readonly iterationRecords: readonly IterationRecord[];
  readonly terminalReason: string;  // "verifier passed", "maxIterations=10 exceeded", etc.
}

export interface IterationRecord {
  readonly iteration: number;
  readonly durationMs: number;
  readonly tokensConsumed: number | "unmetered";
  readonly verifierResult: VerifierResult;
  readonly runtimeError?: string;   // set if runtime.run itself failed
}

export type LoopEvent =
  | { readonly kind: "loop.iteration.start"; readonly iteration: number; readonly prompt: string }
  | { readonly kind: "loop.iteration.complete"; readonly record: IterationRecord }
  | { readonly kind: "loop.verifier.start"; readonly iteration: number }
  | { readonly kind: "loop.verifier.complete"; readonly iteration: number; readonly result: VerifierResult }
  | { readonly kind: "loop.terminal"; readonly result: RunUntilPassResult };

export function runUntilPass(config: RunUntilPassConfig): Promise<RunUntilPassResult>;
```

### 2.2 State machine (explicit, not implicit)

```
      ┌───────┐  start
      │ idle  │────────────┐
      └───────┘            ▼
                    ┌────────────┐  runtime.run done
                    │ iterating  │──────────────────┐
                    └────┬───────┘                  ▼
                         │ timeout/abort     ┌────────────┐
                         │                   │ verifying  │
                         ▼                   └─────┬──────┘
                    ┌──────────┐                   │
                    │ errored  │        ┌──────────┴─────────┐
                    └──────────┘        │ ok            │ !ok
                                        ▼               ▼
                                  ┌──────────┐   ┌──────────────┐
                                  │converged │   │ check budgets│
                                  └──────────┘   └──────┬───────┘
                                                        │
                              ┌───────────────┬─────────┼──────────────┐
                              ▼               ▼         ▼              ▼
                        circuit_broken   exhausted   aborted      iterating
                        (consec>=max)    (iter>=max  (signal)     (next iter)
                                          or budget)
```

Every terminal transition emits `loop.terminal` exactly once. The loop function returns the same `RunUntilPassResult` payload that was in the terminal event — single source of truth.

### 2.3 Budget model — cumulative post-iteration, "unmetered" is explicit

Rewritten from the v1 draft. The earlier plan was internally inconsistent about when to check the budget.

| Rule | Behavior |
|---|---|
| `maxBudgetTokens: "unmetered"` (default) | Loop does not count tokens. `tokensConsumed` in result is literal string `"unmetered"`. Zero ambiguity. |
| `maxBudgetTokens: N` (number) | Loop counts tokens from `EngineEvent.usage` on every `done` event. Check runs **after** each iteration: if `consumed >= N`, terminate with `status: "exhausted"`. No pre-check — we cannot predict next iteration's cost. |
| Adapter never emits usage, but `maxBudgetTokens: N` is set | Loop logs a warning after iteration 2 ("budget set but no usage reported by adapter — budget will never fire"). Loop continues and only iteration/time budgets will terminate it. This is a known limitation, documented in `docs/L2/loop.md`. |

Explicitly rejected: "estimate before iteration start, reserve, reconcile after." Too much machinery for Phase A; deferred until a real use case demands it.

### 2.4 Circuit breaker — port v1 exactly, no text comparison

v1 (`verified-loop.ts:219-227`): increment a pure per-item failure counter on every gate failure, regardless of message content. Reset on success. Trigger skip when counter >= threshold.

Phase A has only one "item" (the single goal), so:

```
consecutiveFailures: number = 0

on verifier fail:
  consecutiveFailures += 1
  if consecutiveFailures >= maxConsecutiveFailures:
    terminate with status: "circuit_broken"
on verifier pass:
  terminate with status: "converged"
```

No text hashing, no normalization, no same-failure detection. **A wrong idea in the earlier draft is removed.** The tradeoff: a genuinely fixed-then-flaky loop could hit the breaker after 3 distinct-cause failures. That is the correct behavior — if the agent can't pass 3 times in a row, the user should know.

### 2.5 Verifier command model — argv only, no shell strings ever

The public gate API takes `string[]` (argv). No `cmd.split(" ")`, no shell metacharacters, no quoting, no env inheritance surprises.

```typescript
export function createArgvGate(
  argv: readonly [string, ...string[]],   // non-empty tuple
  options?: {
    readonly cwd?: string;                // defaults to ctx.workingDir
    readonly env?: Readonly<Record<string, string>>;  // if omitted, inherit
    readonly timeoutMs?: number;          // falls back to verifierTimeoutMs
    readonly stderrBytes?: number;        // default 2048
  },
): Verifier;
```

If a user wants `bun typecheck && bun test`, they compose with `createCompositeGate([createArgvGate(["bun", "typecheck"]), createArgvGate(["bun", "test"])])`. Composite stops at first failure.

**CLI binding.** The `--until-pass` flag is redesigned to take argv, not a shell string:

```bash
# Repeatable flag — each occurrence is one argv token
koi run --until-pass bun --until-pass test "Fix the failing test"

# OR the more idiomatic -- separator for the full argv
koi run --until-pass -- bun test --filter=foo "Fix the foo test"
```

I'll benchmark both CLI ergonomics during implementation; decision commits before shipping. Either way the internal API is `argv: string[]`. No shell.

### 2.6 Zero-event / no-`done` handling is a hard error

Mirrors `packages/lib/harness/src/harness.ts:141-144` — if `runtime.run()` ends without a `done` event, that iteration is an `errored` terminal state, not a silent "verifier failed":

```
if no EngineEvent observed: terminal errored, reason "runtime.run produced zero events"
if stream ended without done: terminal errored, reason "runtime.run stream truncated (no done event)"
```

The iteration does **not** proceed to the verifier in either case. This isolates runtime bugs from verifier bugs and keeps the state machine honest.

### 2.7 Prompt rebuild — sanitized, truncated, bounded

Default `rebuildPrompt`:

```
<initial prompt, verbatim>

---
Previous attempt (iteration N) failed verification:
  reason: <VerifierFailureReason enum>
  exit code: <N or "n/a">

<details, truncated to 2KB, with ANSI codes stripped and control chars redacted>

Fix the failure and try again.
```

Rules:
- Only the **latest** failure is in the default prompt. Not the full history.
- `recentFailures` in `RebuildPromptContext` exposes the last 3 for custom rebuilders, but each entry is already truncated.
- ANSI escapes and control characters are stripped before embedding — prevents a crashing verifier from smuggling terminal control codes back through the prompt.
- 2KB is empirical: enough to include a stack trace + the failing assertion, small enough that 10 iterations cost ~20KB of prompt overhead.

Custom rebuilders get the typed `VerifierResult` so they can branch on `reason` (e.g., show stack traces for `exit_nonzero`, a path for `file_missing`).

### 2.8 Abort — explicit terminal states, `AbortSignal.any` as implementation detail

Section 2.2's state machine is the contract. `AbortSignal.any([externalSignal, iterationTimeout])` is how we implement the "iterating" state's abort wiring; the verifier gets its own `AbortSignal.any([externalSignal, verifierTimeout])`. Critically: **verifier and runtime.run never overlap** (2.4 invariant) — no cross-state races.

Test coverage will assert: (a) aborted-during-iterating → status `aborted`, (b) aborted-during-verifying → status `aborted`, (c) subprocess is killed within 500ms of abort (verifier uses `Bun.spawn({ signal })`), (d) no listener leaks after 100 iterations (`listenerCount` assertion).

## 3. Package structure

```
packages/lib/loop/
├── package.json                    # deps: @koi/core, @koi/errors, @koi/validation
├── tsconfig.json
├── tsup.config.ts
├── src/
│   ├── index.ts
│   ├── types.ts                    # all type definitions
│   ├── run-until-pass.ts           # main loop + state machine (~240 LOC)
│   ├── run-until-pass.test.ts
│   ├── state-machine.ts            # pure transition function, table-tested (~60 LOC)
│   ├── state-machine.test.ts
│   ├── gates/
│   │   ├── argv-gate.ts            # Bun.spawn, argv-only, no shell (~100 LOC)
│   │   ├── argv-gate.test.ts
│   │   ├── file-gate.ts            # port from v1
│   │   ├── file-gate.test.ts
│   │   ├── composite-gate.ts       # port from v1
│   │   └── composite-gate.test.ts
│   ├── rebuild-prompt.ts           # default rebuilder + sanitize helper (~50 LOC)
│   ├── rebuild-prompt.test.ts
│   ├── budget.ts                   # cumulative token accounting (~30 LOC)
│   ├── budget.test.ts
│   └── __tests__/
│       └── integration.test.ts     # real subprocess + fake runtime, full loop
```

**Source budget:** ~480 LOC. **Test budget:** ~700 LOC.

If source trends over 550, I stop and cut gates into a follow-up (ship the loop + a single inline argv gate).

## 4. Test coverage

Convergence & exhaustion:
- [ ] Converges iteration 1 (verifier passes immediately)
- [ ] Converges iteration N after N-1 failures
- [ ] `exhausted` on `maxIterations` hit
- [ ] `exhausted` on `maxBudgetTokens` hit (cumulative post-iteration)
- [ ] `"unmetered"` default never enforces budget even with adapter emitting usage

Budget edge cases:
- [ ] Warning logged when `maxBudgetTokens: N` set but adapter emits no usage over 2+ iterations
- [ ] Budget checked *after* iteration (not before)

Circuit breaker (pure counter):
- [ ] `circuit_broken` after exactly `maxConsecutiveFailures` failures
- [ ] Counter does NOT reset on text-identical failures (regression guard)
- [ ] Counter does NOT reset on text-different failures either (regression guard — it's a pure counter)

Abort + state machine:
- [ ] Pre-aborted signal runs 0 iterations, returns `aborted`
- [ ] Abort during iteration → `aborted`
- [ ] Abort during verifier → `aborted`
- [ ] Verifier subprocess killed within 500ms of abort (real subprocess test)
- [ ] No `AbortSignal` listener accumulation over 100 iterations

Zero-event / no-done:
- [ ] Runtime yields zero events → `errored`, reason mentions zero events
- [ ] Runtime ends without `done` → `errored`, reason mentions truncated stream
- [ ] Verifier is NOT called when runtime errored

Verifier failure taxonomy:
- [ ] `exit_nonzero` populated with exitCode when argv gate process exits 1
- [ ] `spawn_error` when argv gate points at nonexistent binary
- [ ] `timeout` when verifier hangs past `verifierTimeoutMs`
- [ ] `file_missing` / `file_no_match` from file gate
- [ ] `predicate_threw` when custom verifier throws

Prompt rebuild:
- [ ] Default includes only latest failure, not full history
- [ ] ANSI codes stripped from embedded details
- [ ] Details truncated to 2KB exactly
- [ ] Custom rebuilder receives typed `VerifierResult` with correct `reason`

Gates (argv-only contract):
- [ ] `createArgvGate([])` rejected at construction (non-empty tuple)
- [ ] argv-only: passing a shell string like `"bun test"` is a type error (compile-time assertion via `// @ts-expect-error`)
- [ ] Composite stops at first failure, reports first failure's reason

Integration:
- [ ] Real subprocess: failing script → fake runtime writes file → passing script → converges
- [ ] `onEvent` callback receives every event in temporal order, exactly once per event

## 5. Implementation order (TDD)

1. **Doc first** — `docs/L2/loop.md` with the API from section 2.1. CI doc-gate enforces.
2. **Types** — `src/types.ts`, zero logic.
3. **State machine** — `src/state-machine.ts` as a pure transition function, table-tested before any I/O code exists.
4. **Budget + prompt helpers** — small, pure, tested in isolation.
5. **Main loop** — `src/run-until-pass.ts`. Use the state machine, not ad-hoc branching.
6. **Gates** — argv-gate first, then file, then composite. Port from v1 with `cwd` always required.
7. **Integration test** — real Bun subprocess + scripted fake runtime.
8. **Layer registration** — add `@koi/loop` to `scripts/layers.ts` `L2_PACKAGES`.
9. **CLI wiring** — `packages/meta/cli`: add `--until-pass` (argv-only) and `--max-iter` flags, wrap harness single-prompt path.
10. **Golden query (see section 6) — real-LLM recording, NOT a fake.**
11. **CI gates** — `test`, `typecheck`, `lint`, `check:layers`, `check:unused`, `check:duplicates`, `check:orphans`, `check:golden-queries`.

## 6. Golden query — real recording, not a fake

**This is the CRITICAL correction from the adversarial review.** CLAUDE.md lines 459-481 require real LLM + real tools → cassette → replay through `createKoi` with all L2 middleware. A fake runtime satisfies unit tests but **does not** satisfy the golden query contract.

Plan:
1. Add `@koi/loop` as a dependency of `@koi/runtime` (`packages/meta/runtime/package.json`).
2. Add `loop-until-pass` query to `packages/meta/runtime/scripts/record-cassettes.ts`. Fixture project: a 2-file scratch dir with a trivially failing `test.ts` and a `bun test` verifier.
3. Run `OPENROUTER_API_KEY=... bun run packages/meta/runtime/scripts/record-cassettes.ts` **with a real LLM** to produce:
   - `fixtures/loop-until-pass.cassette.json` (ModelChunk[])
   - `fixtures/loop-until-pass.trajectory.json` (full ATIF v1.6)
4. In `golden-replay.test.ts`, add the cassette-backed replay test that wires `createKoi` with ALL L2 middleware (hooks, permissions, event-trace) and runs `runUntilPass` end-to-end. Validate trajectory assertions: iteration events fire, verifier spans are recorded, converged status reached.
5. Add 2 standalone golden queries (no LLM) under `describe("Golden: @koi/loop", ...)`:
   - `loop-converges-immediately`: fake runtime + passing verifier on iteration 1
   - `loop-exhausts`: fake runtime + always-failing verifier hitting `maxIterations`

Unit tests can use a fake runtime freely — that's not the golden query, that's unit coverage.

## 7. Layer-compliance checklist

- [x] Package at `packages/lib/loop/`
- [x] Imports only `@koi/core` (L0) + `@koi/errors`, `@koi/validation` (L0u)
- [x] Does NOT import `@koi/engine` (L1) — structural `LoopRuntime` interface only
- [x] Does NOT import peer L2 packages
- [x] CLI wiring in `packages/meta/cli` (L3)
- [x] Golden wiring in `packages/meta/runtime` (L3)
- [x] `readonly` on every interface property and array
- [x] No `class`, `enum`, `any`, `as`, `!` non-null assertion
- [x] Explicit return types on all exported functions (isolatedDeclarations)
- [x] Result<T,E> pattern for expected failures (config validation, gate errors); `throw` with `cause` for unexpected

## 8. Phase scope and non-promises

**This PR ships single-goal mode only.**

Previously I claimed Phase B (multi-item PRD) would be "purely additive." Codex called this out as not credible, and it's right. Every one of these Phase A fields is *singular*:

- one `verifier`, one `workingDir`, one `initialPrompt`
- one `tokensConsumed` counter
- one `consecutiveFailures` counter
- one `rebuildPrompt` context

Multi-item PRD would need: per-item verifiers, per-item failure counters, shared-or-per-item budgets, partial-success semantics, item skip/rollback, priority ordering. That is a **different shape**, not a superset.

**Explicit non-promise.** If a multi-item mode lands later, it will be a **new public function** (e.g., `createVerifiedLoop`) that may share internal helpers with `runUntilPass` but has its own config, its own result type, and is free to break the naming of `runUntilPass` if we discover a better shared vocabulary. `runUntilPass` is committed to a single-goal API shape and will not grow multi-item fields.

The v1 archive can be ported for the multi-item mode when and if there is demand — it's a well-tested reference. But that's a **separate design conversation** with its own issue, not a follow-up PR on #1624.

## 9. Risk register

1. **Token usage coverage is adapter-dependent.** Documented as a known limitation; warning after 2 iterations without usage.
2. **Subprocess cleanup on abort.** Tested with a real 30s sleep subprocess; assert kill within 500ms.
3. **Golden query recording cost.** One real-LLM run per PR that touches this package. Acceptable — matches existing L2 golden queries.
4. **PR size.** Hard checkpoint at 550 source LOC. If exceeded, split gates into a follow-up and ship just the loop + inline argv gate.
5. **Verifier running in user's cwd by accident.** Mitigated: `workingDir` is a required field, no default. CLI surfaces a `--working-dir` flag alongside `--until-pass`.

## 10. Adversarial-review response

Tracking which Codex findings were addressed and how.

| # | Severity | Finding | Resolution |
|---|---|---|---|
| 1 | CRITICAL | Golden query used a fake runtime, violating CLAUDE.md:459-481 | [§6](#6-golden-query--real-recording-not-a-fake) — real-LLM recording + cassette replay through `createKoi` with all L2 middleware; fake runtime only for unit tests and the 2 standalone goldens |
| 2 | MAJOR | Token budget inconsistent (pre vs post check, adapters without usage) | [§2.3](#23-budget-model--cumulative-post-iteration-unmetered-is-explicit) — cumulative post-iteration only; explicit `"unmetered"` mode as default; warning when budget set but no usage observed |
| 3 | MAJOR | Circuit breaker was exact-string match, regression from v1 | [§2.4](#24-circuit-breaker--port-v1-exactly-no-text-comparison) — pure consecutive-failure counter, ports v1 exactly; regression tests assert no text comparison |
| 4 | MAJOR | `cmd.split(" ")` broke the plan's own example; shell injection surface | [§2.5](#25-verifier-command-model--argv-only-no-shell-strings-ever) — argv-only API, no shell strings ever; CLI uses repeatable flag or `--` separator; composite gate for multi-step |
| 5 | MAJOR | "Phase B is additive" not credible | [§8](#8-phase-scope-and-non-promises) — claim withdrawn; Phase A committed to single-goal shape; multi-item becomes a new function in a separate design |
| 6 | MINOR | Abort design overclaimed correctness | [§2.2](#22-state-machine-explicit-not-implicit) + [§2.8](#28-abort--explicit-terminal-states-abortsignalany-as-implementation-detail) — explicit state machine with 5 terminal states; `AbortSignal.any` is an implementation detail; tests assert subprocess kill + no listener leaks |
| 7 | MINOR | `workingDir` defaulted to `process.cwd()` | §2.1 — `workingDir` is now a REQUIRED field, no default |
| 8 | Missed | Zero-event / no-`done` runtime behavior undefined | [§2.6](#26-zero-event--no-done-handling-is-a-hard-error) — both cases are `errored` terminal state, verifier is not called, mirrors harness pattern |
| 9 | Missed | Verifier failure modes collapsed into generic `ok: false` | §2.1 — `VerifierFailureReason` discriminated union with 7 distinct reasons; tests cover each |
| 10 | Missed | Prompt rebuild had no sanitization / truncation | [§2.7](#27-prompt-rebuild--sanitized-truncated-bounded) — ANSI stripped, control chars redacted, 2KB cap, only latest failure in default rebuild |
