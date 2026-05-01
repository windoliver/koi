# @koi/eval — Agent Evaluation & Self-Test Framework

Defines, runs, and persists evaluation suites against a Koi agent. Grades transcripts with pluggable graders, persists runs for regression detection, and provides a thin self-test layer for capability sanity checks.

---

## Why It Exists

Without an evaluation framework, every agent change ships blind: there is no objective signal that a refactor preserved behavior, no historical baseline to compare against, and no fast feedback loop for prompt or tool tweaks. A separate ad-hoc harness in every project duplicates work and produces incomparable results.

`@koi/eval` solves four problems with one minimal surface:

- **Reproducible runs** — each evaluation produces a serializable `EvalRun` with deterministic IDs, scores, and metadata
- **Pluggable graders** — `EvalGrader` is a single-method contract; new grader kinds plug in without touching the runner
- **Regression detection** — `compareRuns()` flags pass-rate or score drops vs a baseline run
- **Self-test** — the same primitives power a `runSelfTest()` capability check that an agent can run against itself

The runner is intentionally sequential and simple: no worker pool, no LLM-judge grader, no transcript summarization. Those belong in higher-level packages or are out of scope for v2 phase 3.

---

## Architecture

`@koi/eval` is an **L2 feature package** — depends only on `@koi/core` (L0). No other Koi packages, no external runtime deps.

```
┌──────────────────────────────────────────────────────────────┐
│  @koi/eval  (L2)                                             │
│                                                              │
│  types.ts             ← EvalTask, EvalTrial, EvalRun,        │
│                         EvalGrader, EvalScore, EvalSummary,  │
│                         RegressionResult, SelfTestCheck      │
│  runner.ts            ← runEval(): tasks → trials → run      │
│  graders/             ← exact-match.ts, tool-call.ts         │
│  regression.ts        ← compareRuns()                        │
│  store.ts             ← createFsStore() (Bun.file persist)   │
│  self-test.ts         ← runSelfTest() check runner           │
│  index.ts             ← public API                           │
│                                                              │
├──────────────────────────────────────────────────────────────┤
│  Dependencies                                                │
│                                                              │
│  @koi/core   (L0)   EngineEvent, EngineInput,                │
│                      EngineMetrics, JsonObject               │
└──────────────────────────────────────────────────────────────┘
```

---

## How It Works

```
EvalRunConfig
    │
    └── runEval()
            │
            ├── for each task:
            │     for trialIndex in 0..trialCount:
            │         agent = await agentFactory()
            │         transcript = collect(agent.stream(task.input))   // timeout-guarded
            │         scores    = await Promise.all(graders.grade(transcript, expected, metrics))
            │         status    = all(scores.pass) ? "pass" : "fail"   // "error" on throw/timeout
            │         await agent.dispose?.()
            │         emit onTrialComplete(trial)
            │
            ├── summarize trials → EvalSummary
            │
            └── return EvalRun  (id, name, timestamp, config snapshot, trials, summary)
```

### Concepts

| Concept | Purpose |
|---------|---------|
| `EvalTask` | One eval template: input, expected, graders, trialCount, timeoutMs |
| `EvalTrial` | One execution: transcript + scores + status (`pass` \| `fail` \| `error`) |
| `EvalGrader` | `grade(transcript, expected, metrics) => EvalScore` — pluggable |
| `EvalRun` | Full session: config snapshot, all trials, aggregated summary |
| `EvalSummary` | `passRate`, `meanScore`, per-task aggregates |
| `RegressionResult` | `pass` \| `fail` (with deltas) \| `no_baseline` |
| `SelfTestCheck` | `name + run() => CheckResult` — minimal capability assertion |

### Graders

| Grader | Matches when |
|--------|--------------|
| `exactMatch` | Final assistant text matches `string` (substring) or `RegExp` |
| `toolCall` | Required tool calls appear in transcript (any-order or strict) |

Both are stateless functions returning `EvalScore`. Custom graders implement `EvalGrader` and pass to a task.

### Regression Detection

`compareRuns(baseline, current, thresholds?)` returns:

- `pass` if pass-rate drop ≤ `passRateDelta` (default 0.05) and mean-score drop ≤ `scoreDelta` (default 0.1)
- `fail` with `RegressionDetail[]` enumerating offending tasks
- `no_baseline` when baseline is undefined

### Persistence

`createFsStore(rootDir)` returns an `EvalStore`:

- `save(run)` writes `<root>/<evalName>/<runId>.json` (atomic via `Bun.write`)
- `load(runId)` / `latest(name)` / `list(name)` for retrieval
- Pure JSON; no schema migration in v2 — break-changes bump the file format

### Self-Test

`runSelfTest(checks, options?)` runs a sequence of `SelfTestCheck`s with per-check timeout. Returns `SelfTestResult` with pass/fail per check. Designed for an agent to gate its own startup or for CI smoke tests.

---

## Public API

```ts
// Runner
runEval(config: EvalRunConfig): Promise<EvalRun>

// Graders
exactMatch(opts: { id?: string; pattern: string | RegExp }): EvalGrader
toolCall(opts: { id?: string; calls: readonly ExpectedToolCall[]; order?: "strict" | "any" }): EvalGrader

// Regression
compareRuns(
  baseline: EvalRun | undefined,
  current: EvalRun,
  thresholds?: RegressionThresholds,
): RegressionResult

// Store
createFsStore(rootDir: string): EvalStore

// Self-test
runSelfTest(checks: readonly SelfTestCheck[], options?: SelfTestOptions): Promise<SelfTestResult>
```

All return values and arguments are `readonly`. Async by default for I/O-bound interfaces (`grade()` may be sync or async).

---

## Failure Modes

| Failure | Behavior |
|---------|----------|
| Task throws during `agent.stream()` | Trial status `error`, error message captured, run continues |
| Trial exceeds `timeoutMs` | Trial status `error`, message `"timeout"`, run continues |
| Grader throws | Score `{ pass: false, score: 0, reasoning: "<error>" }` |
| Store write fails | Throws — caller decides whether to retry |
| Baseline missing | `compareRuns` returns `{ kind: "no_baseline" }` |

Eval framework is **fail-soft** at the trial level (a single bad task does not kill the run) and **fail-hard** at the runner level (config errors throw immediately).

---

## Extensibility

New grader kinds: implement `EvalGrader`. No changes to runner.
New store backends: implement `EvalStore`. No changes to runner.
New self-test checks: implement `SelfTestCheck`. No changes to `runSelfTest()`.

---

## Out of Scope (v2 phase 3)

- LLM-as-judge graders → `@koi/outcome-evaluator` covers in-loop rubric grading
- Concurrency / worker pool → sequential is sufficient for current scale
- Pass@k / pass^k advanced metrics → can be computed from `EvalRun.trials` externally
- Reporter / CI exit-code helpers → out of scope; consumers format `EvalRun` themselves
- JSON-schema and multi-grader composition → consumers compose graders in their suite definition
