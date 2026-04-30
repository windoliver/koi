# @koi/verified-loop

External-verification execution loop. Iterates an injected agent runner against objective gates (test command, file content, composite) instead of relying on LLM self-assessment. Filesystem (PRD JSON + learnings JSON) is the long-term memory; each iteration receives a clean prompt.

## Layer

L2 — depends on `@koi/core` (L0) and `@koi/errors` (L0u). Zero peer L2 dependencies. Engine-agnostic: callers inject a `runIteration` function that streams `EngineEvent`s from any adapter.

## Purpose

Provides `createVerifiedLoop()`, a Ralph-style orchestrator that:

1. Reads a PRD file describing the work as a list of `PRDItem` (id + description + done flag + priority).
2. Picks the highest-priority undone/unskipped item.
3. Runs the consumer-supplied `runIteration` against a prompt built by `iterationPrompt`.
4. Calls the consumer-supplied `verify` gate to check whether the iteration actually accomplished the item.
5. On pass: marks the item done (atomic write-temp-rename).
6. On fail: bumps a per-item failure counter; after `maxConsecutiveFailures` (default 3), marks the item skipped and moves on.
7. Appends a `LearningsEntry` per iteration (rolling window, default 50).
8. Stops when all items are done/skipped, `maxIterations` reached, or the loop is aborted.

Also exports gate factories:
- `createTestGate(args, opts)` — runs a shell command via `Bun.spawn`, passes on exit 0
- `createFileGate(path, match)` — checks a file's content against string or `RegExp`
- `createCompositeGate(gates)` — AND-combines gates, dedups `itemsCompleted`

## Key Design Decisions

### External verification, not LLM self-assessment

The whole point: an LLM saying "I'm done" is not evidence. The gate is the source of truth. Consumers wire gates to whatever objective signal they trust — `bun test`, file contents, custom checks.

### PRD file is the source of truth

Item state lives in the PRD JSON file, not in memory. Every iteration re-reads the file before picking the next item. This makes the loop crash-safe: kill the process and the next run resumes from whichever items are still `done: false`. It also means a human can edit the PRD between iterations to adjust priorities, add items, or mark something done manually.

### Atomic write-temp-rename

`markDone` and `markSkipped` write to `${path}.tmp` then `rename()` over the original. This guarantees the file is never partially written even if the process is killed mid-write.

### Single-coordinator assumption

The read-modify-write pattern in `markDone`/`markSkipped` is **not safe for concurrent multi-process access** — two coordinators editing the same PRD will silently overwrite each other. If multi-process access is ever needed, callers must add file locking or serialize through a single coordinator. Documented at the top of `prd-store.ts`.

### Bounded everything

| Bound | Default | Purpose |
|-------|---------|---------|
| `maxIterations` | 100 | Hard safety cap on the outer loop |
| `iterationTimeoutMs` | 600_000 | Per-iteration wall clock (10 min) |
| `gateTimeoutMs` | 120_000 | Per-gate-call wall clock (2 min) |
| `maxConsecutiveFailures` | 3 | Skip an item after N consecutive gate failures |
| `maxLearningEntries` | 50 | Rolling window for learnings file |

`AbortSignal.any([abortController.signal, AbortSignal.timeout(ms)])` is used everywhere — the loop, the iteration, and the gate all listen to a unified signal so timeout or external abort drop everything cleanly.

### Learnings are advisory

A malformed `learnings.json` is logged and reset to `[]` rather than failing the loop. The PRD is load-bearing; learnings are a hint for the next iteration's prompt builder.

### `runIteration` is consumer-injected

Verified-loop has zero opinions about which engine adapter runs the iteration. The consumer wires `createKoi(...)` (or any other source of `AsyncIterable<EngineEvent>`) and passes the runner. This keeps the package out of L1's reach and lets it work with mock runners in tests.

### `verify` is consumer-injected

Same principle. The package ships three gate factories as ergonomic defaults but the verification function is just `(GateContext) => Promise<VerificationResult>` — anything that can answer "did it work?" is a valid gate.

## Public API

```typescript
// Orchestrator
createVerifiedLoop(config: VerifiedLoopConfig): VerifiedLoop
//   .run(): Promise<VerifiedLoopResult>
//   .stop(): void

// Gate factories
createTestGate(args: readonly string[], opts?: { cwd?: string; timeoutMs?: number }): VerificationFn
createFileGate(path: string, match: string | RegExp): VerificationFn
createCompositeGate(gates: readonly VerificationFn[]): VerificationFn

// Stores (re-exported for advanced consumers)
readPRD(path: string): Promise<Result<PRDFile, KoiError>>
nextItem(items: readonly PRDItem[]): PRDItem | undefined
markDone(path: string, itemId: string): Promise<Result<void, KoiError>>
markSkipped(path: string, itemId: string): Promise<Result<void, KoiError>>
readLearnings(path: string): Promise<readonly LearningsEntry[]>
appendLearning(path: string, entry: LearningsEntry, maxEntries: number): Promise<void>
```

## Configuration (`VerifiedLoopConfig`)

| Field | Default | Required | Description |
|-------|---------|----------|-------------|
| `runIteration` | — | yes | `(EngineInput) => AsyncIterable<EngineEvent>` |
| `prdPath` | — | yes | Path to PRD JSON file |
| `verify` | — | yes | External verification gate |
| `iterationPrompt` | — | yes | Builds the prompt for each iteration from `IterationContext` |
| `learningsPath` | sibling `learnings.json` of `prdPath` | no | Path to learnings JSON |
| `maxIterations` | 100 | no | Outer loop cap |
| `workingDir` | `process.cwd()` | no | Default cwd for test gates |
| `gateTimeoutMs` | 120_000 | no | Per-gate-call timeout |
| `iterationTimeoutMs` | 600_000 | no | Per-iteration timeout |
| `maxLearningEntries` | 50 | no | Rolling-window cap |
| `maxConsecutiveFailures` | 3 | no | Threshold for skipping a stuck item |
| `signal` | — | no | External `AbortSignal` |
| `onIteration` | — | no | Callback per `IterationRecord` (live progress) |

## File formats

### PRD (`prd.json`)

```json
{
  "items": [
    { "id": "auth", "description": "Implement login", "done": false, "priority": 0 },
    { "id": "ui",   "description": "Build sidebar",   "done": false, "priority": 1 }
  ]
}
```

### Learnings (`learnings.json`)

```json
{
  "entries": [
    {
      "iteration": 1,
      "timestamp": "2026-04-29T...",
      "itemId": "auth",
      "discovered": ["Item auth completed"],
      "failed": [],
      "context": "Working on: Implement login"
    }
  ]
}
```

## Testing

- All filesystem code is exercised against a per-test `tmpdir` via `node:fs/promises.mkdtemp`. No mocks for `Bun.file` / `Bun.write` — they are fast enough on tmpfs.
- The orchestrator is tested with a fake `runIteration` returning a controlled `AsyncIterable<EngineEvent>` and a fake `verify` whose `passed` value is scripted per call. Real time is not used — `iterationTimeoutMs`/`gateTimeoutMs` tests pass shrunk timeouts (e.g. 50 ms) and assert on the unhappy path.
- Coverage threshold ≥ 80% (per `bunfig.toml`).

## Compared to v1

Direct port of `archive/v1/packages/sched/verified-loop` (~789 LOC src). Same public surface. v1 changes carried forward without modification:
- Atomic write-temp-rename in `markDone`/`markSkipped`
- Consecutive-failure skip (added late in v1)
- `AbortSignal.any` composition
- `itemsCompleted` deduplication on multi-completion gates
