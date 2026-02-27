# @koi/middleware-report — Structured Run Report Generation

Generates a typed `RunReport` at the end of every agent session. When an agent runs autonomously for 30 minutes refactoring a module, you get a structured receipt of exactly what happened — every model call, every tool invocation, every error, total cost, and a human-readable summary.

---

## Why It Exists

Without structured reporting, understanding what an autonomous agent did requires scrolling through logs or chat history. The longer the run, the worse this gets.

```
  BEFORE                                AFTER
  ──────                                ─────

  Agent runs 30 min autonomously        Agent runs 30 min autonomously
           │                                     │
           ▼                                     ▼
  📜 Raw logs / chat history            📊 RunReport
                                         │
  ❌ No action summary                  ✅ 47 actions across 12 turns
  ❌ No token/cost accounting           ✅ 128k tokens, $0.42
  ❌ No error inventory                 ✅ 2 issues, both resolved
  ❌ No duration breakdown              ✅ 47s total, 32s in model calls
  ❌ "What did it do?" → read logs      ✅ Structured summary + markdown
```

Benefits:

- **Zero-config defaults** — drop in the middleware, get a report at session end
- **Real-time visibility** — `onProgress` callback and `getProgress()` polling during the run
- **Pluggable summary** — optional AI-powered `summarizer` with deterministic template fallback
- **Bounded memory** — ring-buffer caps action log at `maxActions` (default 500) with O(1) writes
- **Multiple output modes** — pull via `getReport()`, push via `onReport` callback, format as markdown or JSON

---

## Architecture

`@koi/middleware-report` is an **L2 feature package** — depends only on `@koi/core` (L0) and L0u utilities.

```
┌──────────────────────────────────────────────────────────────┐
│  @koi/middleware-report  (L2)                                 │
│                                                              │
│  report.ts        ← createReportMiddleware factory            │
│  accumulator.ts   ← Ring-buffer state collector (O(1) write) │
│  formatters.ts    ← mapReportToMarkdown, mapReportToJson      │
│  config.ts        ← ReportConfig + validateReportConfig       │
│  descriptor.ts    ← BrickDescriptor for manifest resolution   │
│  types.ts         ← ReportHandle interface                    │
│  index.ts         ← Public API surface                        │
│                                                              │
├──────────────────────────────────────────────────────────────┤
│  Dependencies                                                │
│                                                              │
│  @koi/core    (L0)   RunReport, ActionEntry, IssueEntry, etc│
│  @koi/errors  (L0u)  swallowError for callback failures     │
│  @koi/resolve (L0u)  BrickDescriptor for auto-discovery     │
└──────────────────────────────────────────────────────────────┘
```

---

## How It Works

The middleware wraps model calls, tool calls, and lifecycle hooks to collect data. At session end, it assembles everything into a `RunReport`.

```
┌─────────────────────────────────────────────────────────────────┐
│                    Koi Agent Session                             │
│                                                                 │
│  ┌───────────┐   ┌───────────┐   ┌───────────┐   ┌──────────┐ │
│  │  Turn 1    │   │  Turn 2    │   │  Turn 3    │   │ Turn 4   │ │
│  │           │   │           │   │           │   │          │ │
│  │ model_call│   │ model_call│   │ model_call│   │model_call│ │
│  │ file_read │   │ file_read │   │ file_write│   │file_write│ │
│  │           │   │ file_write│   │ test_run  │   │test_run  │ │
│  │           │   │           │   │ ⚠ FAIL    │   │ ✓ PASS   │ │
│  └─────┬─────┘   └─────┬─────┘   └─────┬─────┘   └────┬─────┘ │
│        │               │               │              │        │
│        ▼               ▼               ▼              ▼        │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │          @koi/middleware-report (priority 275)           │   │
│  │                                                         │   │
│  │  wrapModelCall  ──► record action + tokens              │   │
│  │  wrapModelStream──► accumulate usage chunks + action    │   │
│  │  wrapToolCall   ──► record action + errors              │   │
│  │  onAfterTurn    ──► turnCount++ ──► onProgress(snap)    │   │
│  │  onSessionEnd   ──► assemble RunReport ──► onReport()   │   │
│  └─────────────────────────────┬───────────────────────────┘   │
│                                │                               │
└────────────────────────────────┼───────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────┐
│                        RunReport                                │
│                                                                 │
│  ┌─ Summary ──────────────────────────────────────────────────┐ │
│  │ Completed 9 actions across 4 turns in 47320ms.             │ │
│  │ Used 12,840 tokens (8,200 input, 4,640 output).            │ │
│  │ 1 issues encountered, 1 resolved.                          │ │
│  └────────────────────────────────────────────────────────────┘ │
│                                                                 │
│  ┌─ Actions ──────────────────────────────────────────────────┐ │
│  │ # │ Type       │ Name       │ Turn │ Duration │ Status     │ │
│  │ 1 │ model_call │ haiku-4.5  │  0   │  2340ms  │ success    │ │
│  │ 2 │ tool_call  │ file_read  │  0   │    12ms  │ success    │ │
│  │ 3 │ model_call │ haiku-4.5  │  1   │  3100ms  │ success    │ │
│  │ 4 │ tool_call  │ file_read  │  1   │     8ms  │ success    │ │
│  │ 5 │ tool_call  │ file_write │  1   │    45ms  │ success    │ │
│  │ 6 │ model_call │ haiku-4.5  │  2   │  2890ms  │ success    │ │
│  │ 7 │ tool_call  │ file_write │  2   │    32ms  │ success    │ │
│  │ 8 │ tool_call  │ test_run   │  2   │  8200ms  │ error      │ │
│  │ 9 │ model_call │ haiku-4.5  │  3   │  3400ms  │ success    │ │
│  └────────────────────────────────────────────────────────────┘ │
│                                                                 │
│  ┌─ Issues ───────────────────────────────────────────────────┐ │
│  │ ⚠ warning │ Tool test_run failed: 2 tests failed │ Turn 2  │ │
│  └────────────────────────────────────────────────────────────┘ │
│                                                                 │
│  ┌─ Cost ─────────────────────────────────────────────────────┐ │
│  │ Input: 8,200  Output: 4,640  Total: 12,840  Est: $0.0089  │ │
│  └────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
```

---

## Data Flow

Three ways to consume report data — pick one or combine:

```
                                 │
                 ┌───────────────┼───────────────┐
                 ▼               ▼               ▼
          ┌─────────────┐ ┌───────────┐  ┌──────────────┐
          │ getReport() │ │ onReport  │  │ getProgress() │
          │             │ │ callback  │  │ + onProgress  │
          │ Pull after  │ │ Push at   │  │              │
          │ session end │ │ session   │  │ Live during  │
          │             │ │ end       │  │ the run      │
          └──────┬──────┘ └─────┬─────┘  └──────┬───────┘
                 │              │               │
                 ▼              ▼               ▼
          ┌─────────────┐ ┌───────────┐  ┌──────────────┐
          │ Store in DB │ │ Post to   │  │ Update UI    │
          │ (ReportStore│ │ Slack /   │  │ progress bar │
          │  interface) │ │ dashboard │  │ or spinner   │
          └─────────────┘ └───────────┘  └──────────────┘
```

---

## The RunReport

Every report is a typed `RunReport` — the core data type defined in `@koi/core`:

```typescript
interface RunReport {
  readonly agentId: AgentId
  readonly sessionId: SessionId
  readonly runId: RunId
  readonly summary: string                         // Human-readable summary
  readonly objective?: string                      // What the agent was trying to do
  readonly duration: RunDuration                   // Timing + turn/action counts
  readonly actions: readonly ActionEntry[]         // Bounded action log
  readonly artifacts: readonly ArtifactRef[]       // Produced files/data
  readonly issues: readonly IssueEntry[]           // Errors and warnings
  readonly cost: RunCost                           // Token counts + optional USD
  readonly recommendations: readonly string[]      // From summarizer
  readonly childReports?: readonly RunReport[]     // Nested agent reports (future)
  readonly metadata?: JsonObject                   // Extensible
}
```

### ActionEntry

Each model call and tool call produces one entry:

```typescript
interface ActionEntry {
  readonly kind: "model_call" | "tool_call"
  readonly name: string           // Model name or tool ID
  readonly turnIndex: number      // Which turn this occurred in
  readonly durationMs: number     // Wall-clock time
  readonly success: boolean       // Did it complete without error?
  readonly errorMessage?: string  // If success === false
  readonly tokenUsage?: {         // Model calls only
    readonly inputTokens: number
    readonly outputTokens: number
  }
}
```

### IssueEntry

Errors during the run are captured as issues:

```typescript
interface IssueEntry {
  readonly severity: "critical" | "warning" | "info"
  readonly message: string
  readonly turnIndex: number
  readonly resolved: boolean
  readonly resolution?: string
}
```

| Source | Severity | Example |
|--------|----------|---------|
| Model call throws | `critical` | "Model call failed: rate limit exceeded" |
| Tool call throws | `warning` | "Tool file_write failed: permission denied" |
| Summarizer timeout | (swallowed) | Falls back to template summary |

---

## Middleware Hooks

The middleware (priority 275) uses 6 hooks:

| Hook | What it does |
|------|-------------|
| `onSessionStart` | Record start timestamp, reset accumulator |
| `wrapModelCall` | Time the call, record action + tokens, capture errors as critical issues |
| `wrapModelStream` | Yield chunks, accumulate usage from `usage` chunks, record action |
| `wrapToolCall` | Time the call, record action, capture errors as warning issues |
| `onAfterTurn` | Increment turn counter, fire `onProgress` callback |
| `onSessionEnd` | Assemble RunReport, invoke summarizer, format, deliver via `onReport` |

### `onSessionEnd` Flow

```
  1. Record completedAt timestamp
  2. Take accumulator snapshot
  3. Call costProvider() if configured        ──► swallowError on failure
  4. Build ReportData for summarizer
  5. Call summarizer(data) with timeout       ──► template fallback on failure
  6. Assemble RunReport
  7. Store in handle (getReport() returns it)
  8. Format with formatter (default: markdown)
  9. Call onReport(report, formatted)         ──► swallowError on failure
```

---

## Accumulator

The accumulator uses a **ring-buffer** for O(1) action recording with bounded memory.

```
  maxActions = 5

  Record 7 actions:  a0  a1  a2  a3  a4  a5  a6

  Buffer state:      [a5] [a6] [a2] [a3] [a4]
                       ^         ^
                      head     oldest visible
                      (next overwrite)

  snapshot() linearizes:  [a2, a3, a4, a5, a6]   (chronological)
  totalActions:           7
  truncated:              true
```

| Operation | Complexity | Notes |
|-----------|-----------|-------|
| `recordAction` | O(1) | Overwrites at cursor, no allocation |
| `snapshot` | O(n) | Linearizes ring-buffer (read path, infrequent) |
| `addTokens` | O(1) | Counter increment |
| `reset` | O(1) | Zero all state |

---

## Summary Generation

Two modes — deterministic template (default) or pluggable AI summarizer:

```
                    ┌────────────────────┐
                    │  config.summarizer │
                    │  provided?         │
                    └─────────┬──────────┘
                              │
                    ┌─────────┴─────────┐
                    │ yes               │ no
                    ▼                   ▼
            ┌───────────────┐   ┌───────────────────┐
            │ Call summarizer│   │ Template summary   │
            │ with timeout   │   │                   │
            │ (default 30s)  │   │ "Completed N      │
            └───────┬───────┘   │  actions across M  │
                    │           │  turns in Xms..."  │
              ┌─────┴─────┐    └───────────────────┘
              │ success   │ failure
              ▼           ▼
      ┌──────────────┐  ┌───────────────────┐
      │ Use returned │  │ Fall back to       │
      │ summary +    │  │ template summary   │
      │ recommendations│ │ recommendations=[] │
      └──────────────┘  └───────────────────┘
```

Template output example:

```
Completed 9 actions across 4 turns in 47320ms.
Used 12840 tokens (8200 input, 4640 output).
1 issues encountered, 1 resolved.
```

---

## ReportConfig

All fields are optional. Empty `{}` is valid.

```typescript
interface ReportConfig {
  readonly objective?: string               // What the agent is trying to do
  readonly summarizer?: ReportSummarizer    // AI-powered summary function
  readonly summarizerTimeoutMs?: number     // Default 30,000ms
  readonly costProvider?: CostProvider      // () => { estimatedCostUsd }
  readonly formatter?: ReportFormatter      // Default: mapReportToMarkdown
  readonly maxActions?: number              // Default 500, ring-buffer capacity
  readonly onReport?: ReportCallback        // Push notification at session end
  readonly onProgress?: ProgressCallback    // Push notification after each turn
}
```

| Callback | Signature | When | Failure handling |
|----------|-----------|------|-----------------|
| `summarizer` | `(data: ReportData) => Promise<ReportSummary>` | Session end | Timeout + swallow → template fallback |
| `costProvider` | `() => CostSnapshot \| Promise<CostSnapshot>` | Session end | Swallow → `estimatedCostUsd` undefined |
| `formatter` | `(report: RunReport) => string` | Session end | Used in `onReport` second arg |
| `onReport` | `(report, formatted) => void \| Promise<void>` | Session end | Swallow error |
| `onProgress` | `(snap: ProgressSnapshot) => void \| Promise<void>` | After each turn | Swallow error |

---

## ProgressSnapshot

Live telemetry available during the run:

```typescript
interface ProgressSnapshot {
  readonly turnIndex: number       // Current turn (0-based)
  readonly totalActions: number    // Actions recorded so far
  readonly inputTokens: number     // Cumulative input tokens
  readonly outputTokens: number    // Cumulative output tokens
  readonly totalTokens: number     // input + output
  readonly issueCount: number      // Issues so far
  readonly elapsedMs: number       // Time since session start
  readonly truncated: boolean      // Action log hit maxActions?
}
```

Two access patterns:

| Method | Pattern | When |
|--------|---------|------|
| `handle.getProgress()` | Pull (polling) | Anytime during the run |
| `config.onProgress` | Push (callback) | Fires after each turn completes |

---

## Output Formats

### Markdown (`mapReportToMarkdown`)

```markdown
# Run Report

## Summary
Completed 9 actions across 4 turns in 47320ms...

## Objective
Refactor auth module to use JWT

## Duration
- Started: 2026-02-27T10:00:00.000Z
- Completed: 2026-02-27T10:00:47.320Z
- Duration: 47320ms
- Turns: 4
- Actions: 9

## Actions
| # | Type | Name | Turn | Duration | Status |
|---|------|------|------|----------|--------|
| 1 | model_call | haiku-4.5 | 0 | 2340ms | success |
| 2 | tool_call | file_read | 0 | 12ms | success |
...

## Issues
| Severity | Message | Turn | Resolved |
|----------|---------|------|----------|
| warning | Tool test_run failed: 2 tests failed | 2 | yes |

## Cost
- Input tokens: 8200
- Output tokens: 4640
- Total tokens: 12840
- Estimated cost: $0.0089

## Recommendations
- Add retry logic for flaky tests
- Consider caching file reads
```

### JSON (`mapReportToJson`)

`JSON.stringify(report, null, 2)` — the `RunReport` is already structured.

---

## API Reference

### Factory Function

#### `createReportMiddleware(config?: ReportConfig): ReportHandle`

Returns a handle with:

| Property | Type | Description |
|----------|------|-------------|
| `middleware` | `KoiMiddleware` | Register this in `createKoi({ middleware: [...] })` |
| `getReport()` | `() => RunReport \| undefined` | Returns the report after session end, `undefined` before |
| `getProgress()` | `() => ProgressSnapshot` | Returns live snapshot anytime during the run |

### Formatters

#### `mapReportToMarkdown(report: RunReport): string`

Generates a multi-section markdown document with tables for actions, artifacts, issues. Handles child reports recursively.

#### `mapReportToJson(report: RunReport): string`

Pretty-printed JSON. Trivial wrapper — the report is already structured.

### Validation

#### `validateReportConfig(input: unknown): Result<ReportConfig, KoiError>`

Validates `maxActions > 0` and `summarizerTimeoutMs > 0` if provided.

### Descriptor

#### `descriptor: BrickDescriptor<KoiMiddleware>`

For manifest-driven auto-discovery. Resolves `middleware-report` brick name to `createReportMiddleware`.

### Types

| Type | Description |
|------|-------------|
| `ReportConfig` | Configuration for `createReportMiddleware` |
| `ReportHandle` | Returned by factory — `{ middleware, getReport, getProgress }` |
| `ReportData` | Passed to `summarizer` — actions, issues, duration, cost |
| `ReportSummarizer` | `(data: ReportData) => Promise<ReportSummary>` |
| `CostProvider` | `() => CostSnapshot \| Promise<CostSnapshot>` |
| `CostSnapshot` | `{ estimatedCostUsd: number }` |
| `ReportFormatter` | `(report: RunReport) => string` |
| `ReportCallback` | `(report, formatted) => void \| Promise<void>` |
| `ProgressCallback` | `(snap: ProgressSnapshot) => void \| Promise<void>` |
| `ProgressSnapshot` | Live telemetry snapshot |

L0 types (from `@koi/core`):

| Type | Description |
|------|-------------|
| `RunReport` | The complete report object |
| `ActionEntry` | One model call or tool call record |
| `IssueEntry` | Error/warning captured during the run |
| `RunDuration` | Timing + turn/action counts |
| `RunCost` | Token counts + optional USD estimate |
| `ReportSummary` | `{ summary, recommendations }` |
| `ReportStore` | Interface for persistent storage (implementation deferred) |
| `ArtifactRef` | Reused from `@koi/core/handoff` |

---

## Examples

### 1. Basic Usage (Zero Config)

```typescript
import { createKoi } from "@koi/engine";
import { createPiAdapter } from "@koi/engine-pi";
import { createReportMiddleware } from "@koi/middleware-report";

const report = createReportMiddleware({});

const runtime = await createKoi({
  manifest: { name: "my-agent", version: "1.0.0", model: { name: "claude-sonnet" } },
  adapter: createPiAdapter({ model: "anthropic:claude-sonnet-4-6", ... }),
  middleware: [report.middleware],
});

// Agent runs autonomously...
await collectEvents(runtime.run({ kind: "text", text: "Refactor the auth module" }));
await runtime.dispose();

// Get the report
const result = report.getReport();
console.log(result?.summary);
// → "Completed 15 actions across 6 turns in 89420ms. Used 45,200 tokens..."
```

### 2. With Callbacks (Push Notifications)

```typescript
const report = createReportMiddleware({
  objective: "Refactor auth module to use JWT",

  // Live progress during the run
  onProgress: (snap) => {
    updateProgressBar(snap.totalActions, snap.elapsedMs);
  },

  // Final report delivery
  onReport: async (report, markdown) => {
    await postToSlack("#agent-reports", markdown);
    await db.reports.insert(report);
  },
});
```

### 3. With AI-Powered Summarizer

```typescript
import type { ReportData, ReportSummarizer } from "@koi/middleware-report";

const summarizer: ReportSummarizer = async (data) => {
  const prompt = `Summarize this agent run:\n${JSON.stringify(data, null, 2)}`;
  const response = await callLLM(prompt);
  return {
    summary: response.text,
    recommendations: response.recommendations ?? [],
  };
};

const report = createReportMiddleware({
  summarizer,
  summarizerTimeoutMs: 15_000,  // 15s timeout (default 30s)
});
```

### 4. With Cost Estimation

```typescript
const report = createReportMiddleware({
  costProvider: async () => {
    const usage = await billingAPI.getSessionUsage();
    return { estimatedCostUsd: usage.totalCostUsd };
  },
});

// After session:
const r = report.getReport()!;
console.log(`Cost: $${r.cost.estimatedCostUsd?.toFixed(4)}`);
// → "Cost: $0.0089"
```

### 5. Custom Formatter

```typescript
const report = createReportMiddleware({
  formatter: (r) => [
    `Agent: ${r.agentId}`,
    `Actions: ${r.actions.length}`,
    `Tokens: ${r.cost.totalTokens}`,
    `Issues: ${r.issues.length}`,
    r.summary,
  ].join("\n"),

  onReport: (_report, formatted) => {
    console.log(formatted);
  },
});
```

### 6. Bounded Action Log

```typescript
// Keep only the last 50 actions (useful for long-running agents)
const report = createReportMiddleware({
  maxActions: 50,
});

// After a 200-action run:
const r = report.getReport()!;
r.actions.length;          // → 50 (most recent 50)
r.duration.totalActions;   // → 200 (total count preserved)
r.duration.truncated;      // → true
```

### 7. Polling Progress Mid-Run

```typescript
const report = createReportMiddleware({});

// In another middleware or external monitor:
const interval = setInterval(() => {
  const snap = report.getProgress();
  console.log(`Actions: ${snap.totalActions}, Tokens: ${snap.totalTokens}, Elapsed: ${snap.elapsedMs}ms`);
}, 5_000);

// ... agent runs ...

clearInterval(interval);
```

---

## Edge Cases

| Scenario | Behavior |
|----------|----------|
| Empty session (0 turns) | Valid report: `totalTurns=0`, `totalActions=0`, empty arrays |
| Model call throws | Error re-thrown. Issue recorded as `critical`. Action marked `success=false` |
| Tool call throws | Error re-thrown. Issue recorded as `warning`. Action marked `success=false` |
| Summarizer throws/times out | Falls back to deterministic template summary. `recommendations=[]` |
| Session aborted mid-turn | `onSessionEnd` still fires. Report has partial data, `totalTurns` reflects only completed turns |
| Action log overflow | Ring-buffer FIFO: oldest entries dropped, `truncated=true`, `totalActions` still counts all |
| `costProvider` throws | Swallowed. `estimatedCostUsd` is `undefined` |
| `onReport` throws | Swallowed. Report is still available via `getReport()` |
| `onProgress` throws | Swallowed. Turn processing continues |
| `getReport()` before session end | Returns `undefined` |
| `getProgress()` before session start | Returns zeroed snapshot (`elapsedMs=0`, all counts 0) |

---

## Layer Compliance

```
L0  @koi/core ────────────────────────────────────────────────┐
    RunReport, ActionEntry, IssueEntry, RunCost, RunDuration   │
    ArtifactRef (reused from handoff.ts)                       │
                                                               │
L0u @koi/errors ──────────────────────────────────────────┐    │
    swallowError                                          │    │
                                                          │    │
L0u @koi/resolve ─────────────────────────────────────┐   │    │
    BrickDescriptor                                   │   │    │
                                                      │   │    │
L2  @koi/middleware-report ◄──────────────────────────┴───┴────┘
    imports from L0 + L0u only
    ✗ never imports @koi/engine (L1)
    ✗ never imports peer L2 packages
```

- [x] `@koi/core/run-report.ts` has zero imports from other `@koi/*` packages
- [x] `@koi/core/run-report.ts` has no function bodies (types/interfaces only)
- [x] No vendor types (LangGraph, OpenAI, etc.) in any file
- [x] Runtime source imports from `@koi/core`, `@koi/errors`, `@koi/resolve` only
- [x] `@koi/engine` and `@koi/engine-pi` are devDependencies (E2E tests only)
- [x] All interface properties are `readonly`
- [x] All array parameters are `readonly T[]`
