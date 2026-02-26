# @koi/long-running — Multi-Session Agent Harness for Long-Horizon Tasks

State manager for agents that operate over hours or days across multiple sessions. Tracks task progress, bridges context between sessions via structured summaries, checkpoints at meaningful task boundaries, and captures key artifacts — enabling an agent to pick up exactly where it left off after any session boundary.

---

## Why It Exists

Single-session agents lose all context when a session ends. Crash recovery (`SessionPersistence`) restores opaque engine state, but it knows nothing about _what the agent was doing_ — which tasks are done, what was learned, or what to work on next.

`@koi/long-running` adds **semantic multi-session management** on top of existing persistence primitives:

- **Task tracking** — knows which tasks are pending, completed, or failed across sessions
- **Context bridging** — builds a structured resume prompt from summaries and artifacts so the agent doesn't start blind
- **Soft checkpoints** — saves engine state every N turns so crash recovery loses minimal work
- **Artifact capture** — records notable tool outputs for cross-session continuity
- **Pinned messages** — resume context is marked `pinned: true` so the compactor never erases it

Without this package, every long-running agent would reinvent progress tracking, session handoff, and context reconstruction.

---

## Architecture

`@koi/long-running` is an **L2 feature package** — it depends only on L0 (`@koi/core`). Zero external dependencies.

```
┌──────────────────────────────────────────────────────────────────┐
│  @koi/long-running  (L2)                                          │
│                                                                    │
│  types.ts              ← Config, LongRunningHarness interface      │
│  harness.ts            ← Factory + state machine implementation    │
│  context-bridge.ts     ← Builds resume context from snapshots      │
│  checkpoint-policy.ts  ← Soft checkpoint timing + ID generation    │
│  index.ts              ← Public API surface                        │
│                                                                    │
├──────────────────────────────────────────────────────────────────  │
│  Dependencies                                                      │
│                                                                    │
│  @koi/core  (L0)   HarnessId, HarnessSnapshot, HarnessStatus,     │
│                     TaskBoardSnapshot, TaskItemId, TaskResult,      │
│                     SessionPersistence, EngineInput, EngineState,   │
│                     Result, KoiError, KoiMiddleware, InboundMessage │
└──────────────────────────────────────────────────────────────────  ┘
```

---

## How It Works

The harness is a **state manager called at session boundaries by Node** — it is not a middleware or engine decorator. It owns the task plan, context summaries, and progress tracking. Engine state lives in `SessionPersistence` (crash recovery). Harness state lives in `SnapshotChainStore<HarnessSnapshot>` (semantic history).

```
┌──────────────────────────────────────────────────────────────────┐
│                      External Caller (Node)                        │
│  "start a multi-day task, pause at session end, resume tomorrow"  │
└────────────────────────┬─────────────────────────────────────────┘
                         │
    start(plan) ─────────┤
    resume() ────────────┤
    pause(result) ───────┤
    completeTask(id) ────┤
    fail(error) ─────────┤
    status() ────────────┘
                         │
                         ▼
┌──────────────────────────────────────────────────────────────────┐
│              @koi/long-running Harness                              │
│                                                                    │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │                  Phase State Machine                        │  │
│  │                                                            │  │
│  │   idle ──start()──> active ──pause()──> suspended          │  │
│  │                       │                     │              │  │
│  │                       │ completeTask()       │ resume()     │  │
│  │                       │ (all done)          │              │  │
│  │                       ▼                     ▼              │  │
│  │                   completed             active (again)     │  │
│  │                                                            │  │
│  │   active/suspended ──fail()──> failed                      │  │
│  └────────────────────────────────────────────────────────────┘  │
│                                                                    │
│  ┌─────────────┐  ┌───────────────┐  ┌────────────────────────┐  │
│  │ TaskBoard   │  │ Summaries     │  │ KeyArtifacts           │  │
│  │ pending: 3  │  │ session 1: .. │  │ code_search @ turn 5   │  │
│  │ done: 2     │  │ session 2: .. │  │ file_write @ turn 12   │  │
│  └─────────────┘  └───────────────┘  └────────────────────────┘  │
│                                                                    │
│  Persistence:                                                      │
│  ├─ HarnessSnapshot → SnapshotChainStore (semantic history)        │
│  └─ EngineState     → SessionPersistence  (crash recovery)         │
└──────────────────────────────────────────────────────────────────┘
```

---

## Multi-Session Lifecycle

A typical multi-session workflow:

```
Session 1                    Session 2                    Session 3
─────────────────────────    ─────────────────────────    ──────────────
start(plan)                  resume()                     resume()
  │                            │                            │
  │ engine runs with           │ engine resumes with        │ engine resumes
  │ harness middleware         │ context bridge OR          │ ...
  │                            │ engine state recovery      │
  │ onAfterTurn:               │                            │
  │   soft checkpoint @5,10    │ completeTask("task-2")     │ completeTask("task-3")
  │                            │                            │  → all done!
  │ completeTask("task-1")     │                            │  → phase = completed
  │                            │                            │
pause(sessionResult)         pause(sessionResult)
  │                            │
  │ snapshot v1                │ snapshot v2
  │ metrics merged             │ metrics merged
  │ summary appended           │ summary appended
  │ engine state saved         │ chain pruned
  │                            │
  ▼                            ▼
 [suspended]                  [suspended]                  [completed]
```

### Resume Strategy

When `resume()` is called, the harness attempts two strategies in order:

1. **Engine state recovery** — loads the latest `SessionCheckpoint` from `SessionPersistence`. If found, returns `{ kind: "resume", state }` so the engine can restore its internal state. This is the "hot" path — cheapest and most accurate.

2. **Context bridge fallback** — if no checkpoint exists, builds `InboundMessage[]` from the harness snapshot's task board, summaries, and artifacts. Returns `{ kind: "messages", messages }`. Messages are marked `pinned: true` to survive compaction.

```
resume()
   │
   ├── loadLatestCheckpoint(agentId)
   │       │
   │       ├── found? → { kind: "resume", state }     ← hot path
   │       │
   │       └── not found?
   │               │
   │               └── buildResumeContext(snapshot)
   │                       │
   │                       └── { kind: "messages", messages }  ← cold path
   │                            (messages are pinned: true)
   │
   └── sessionSeq++
```

---

## Middleware Hooks

`harness.createMiddleware()` returns a `KoiMiddleware` named `"long-running-harness"` (priority 50) with three hooks:

### onAfterTurn — Soft Checkpoints

Every `softCheckpointInterval` turns (default: 5), fires a soft checkpoint to `SessionPersistence`. If `saveState` callback is provided, captures real engine state; otherwise uses a placeholder.

```
Turn 1  2  3  4  5  6  7  8  9  10  11  12  ...
                  ↑                 ↑
              checkpoint         checkpoint
```

### wrapToolCall — Artifact Capture

When a tool's name matches `artifactToolNames`, captures the tool response as a `KeyArtifact`. Artifacts are stored in the snapshot and included in resume context.

### onSessionEnd — Artifact Flush

On session end, flushes any captured artifacts to the harness snapshot. Respects `maxKeyArtifacts` limit (default: 10), keeping the newest.

---

## Configuration

```typescript
interface LongRunningConfig {
  readonly harnessId: HarnessId;           // Unique harness identifier
  readonly agentId: AgentId;               // Agent this harness manages
  readonly harnessStore: HarnessSnapshotStore;  // DAG store for semantic history
  readonly sessionPersistence: SessionPersistence; // Crash recovery store
  readonly softCheckpointInterval?: number;     // Default: 5 turns
  readonly maxKeyArtifacts?: number;            // Default: 10
  readonly maxContextTokens?: number;           // Default: 3000
  readonly artifactToolNames?: readonly string[]; // Tools to capture
  readonly pruningPolicy?: PruningPolicy;       // Default: { retainCount: 10 }
  readonly saveState?: SaveStateCallback;       // Capture real engine state
}
```

### SaveStateCallback

Optional callback invoked during soft checkpoints to capture real engine state instead of a placeholder:

```typescript
type SaveStateCallback = () => EngineState | Promise<EngineState>;
```

---

## Context Bridge

The context bridge builds resume prompts from harness snapshots. It operates within a token budget (default: 3000 tokens) and includes content in priority order:

1. **Task plan** (always included) — formatted task board with status icons
2. **Session summaries** (newest first, up to half remaining budget)
3. **Key artifacts** (newest first, up to half remaining budget)

```
## Task Plan

[x] task-1: Set up database schema
[x] task-2: Implement user authentication
[ ] task-3: Build API endpoints
[ ] task-4: Write integration tests

Completed: 2/4

## Previous Session Summaries

Session 2: Implemented JWT auth with refresh tokens. Added bcrypt hashing.
Session 1: Created PostgreSQL schema with users, sessions, and roles tables.

## Key Artifacts

[code_search @ turn 12]: Found 3 matching files in src/auth/
[file_write @ turn 8]: Created migrations/001_users.sql
```

All resume messages are marked `pinned: true` — the compactor middleware will never summarize them away.

---

## Examples

### Minimal — Single-Session Task

```typescript
import { createLongRunningHarness } from "@koi/long-running";
import type { LongRunningConfig } from "@koi/long-running";
import { harnessId, agentId, taskItemId } from "@koi/core";

const config: LongRunningConfig = {
  harnessId: harnessId("my-harness"),
  agentId: agentId("agent-1"),
  harnessStore: mySnapshotStore,
  sessionPersistence: mySessionPersistence,
};

const harness = createLongRunningHarness(config);

// Start with a task plan
const startResult = await harness.start({
  items: [
    {
      id: taskItemId("task-1"),
      description: "Implement user auth",
      dependencies: [],
      priority: 0,
      maxRetries: 3,
      retries: 0,
      status: "pending",
    },
  ],
  results: [],
});

// Mark task complete
await harness.completeTask(taskItemId("task-1"), {
  taskId: taskItemId("task-1"),
  output: "JWT auth implemented",
  durationMs: 45000,
});

// harness.status().phase === "completed"
```

### Multi-Session with Engine Integration

```typescript
import { createLongRunningHarness } from "@koi/long-running";
import { createKoi } from "@koi/engine";

const harness = createLongRunningHarness(config);

// --- Session 1 ---
const startResult = await harness.start(taskPlan);
if (!startResult.ok) throw new Error(startResult.error.message);

const runtime = await createKoi({
  manifest,
  adapter,
  middleware: [harness.createMiddleware()],
});

// Run with the harness-generated engine input
for await (const event of runtime.run(startResult.value.engineInput)) {
  // Process events...
}

// End session — persist state
await harness.pause({
  sessionId: startResult.value.sessionId,
  metrics: { totalTokens: 5000, inputTokens: 3000, outputTokens: 2000, turns: 8, durationMs: 60000 },
  summary: "Completed database schema setup. Created 3 migration files.",
});

// --- Session 2 (hours later) ---
const resumeResult = await harness.resume();
if (!resumeResult.ok) throw new Error(resumeResult.error.message);

const runtime2 = await createKoi({
  manifest,
  adapter,
  middleware: [harness.createMiddleware()],
});

for await (const event of runtime2.run(resumeResult.value.engineInput)) {
  // Agent resumes with full context...
}
```

### With SaveState Callback

```typescript
const harness = createLongRunningHarness({
  ...config,
  saveState: async () => adapter.getState(),  // Capture real engine state
  softCheckpointInterval: 3,                   // Checkpoint every 3 turns
  artifactToolNames: ["code_search", "file_write", "shell"],
});
```

### Handling Failures

```typescript
try {
  // Agent encounters unrecoverable error
} catch (e: unknown) {
  await harness.fail({
    code: "EXTERNAL",
    message: e instanceof Error ? e.message : String(e),
    retryable: false,
  });
  // harness.status().phase === "failed"
  // harness.status().failureReason === error message
}
```

### Testing with In-Memory Stores

```typescript
import { createLongRunningHarness } from "@koi/long-running";
import { createInMemorySnapshotChainStore } from "@koi/snapshot-chain-store";
import { createMockHarness, createMockTaskPlan } from "@koi/test-utils";

// Option A: Real harness with in-memory stores
const harness = createLongRunningHarness({
  harnessId: harnessId("test"),
  agentId: agentId("test-agent"),
  harnessStore: createInMemorySnapshotChainStore(),
  sessionPersistence: mockSessionPersistence,
});

// Option B: Mock harness for unit tests
const mock = createMockHarness();
await mock.start(createMockTaskPlan(3));
```

---

## Checkpoint Policy

Two pure functions control soft checkpoint behavior:

### shouldSoftCheckpoint

Determines if a soft checkpoint should fire at the current turn:

```typescript
shouldSoftCheckpoint(turnIndex: 0, interval: 5)  // false (turn 0 never fires)
shouldSoftCheckpoint(turnIndex: 5, interval: 5)  // true
shouldSoftCheckpoint(turnIndex: 7, interval: 5)  // false
shouldSoftCheckpoint(turnIndex: 10, interval: 5) // true
```

### computeCheckpointId

Generates a deterministic checkpoint ID from harness, session, and turn:

```typescript
computeCheckpointId(harnessId("h1"), "session-1", 5)
// → "h1:session-1:5"
```

---

## Pinned Messages and Compaction

Resume context messages are marked `pinned: true` on `InboundMessage`. The `@koi/middleware-compactor` respects this flag — pinned messages are never included in the compaction head (summarized portion). This ensures harness context survives even aggressive compaction.

```
Context window during Session 2:

┌──────────────────────────────────────────────────────┐
│ [pinned] Harness resume context                       │  ← never compacted
│   Task plan, summaries, artifacts                    │
│                                                      │
│ [compactable] Old conversation turns                 │  ← compactor may
│ ...                                                  │     summarize these
│                                                      │
│ [preserved] Recent turns (preserveRecent)            │  ← always kept
└──────────────────────────────────────────────────────┘
```

---

## API Reference

### Factory Functions

| Function | Returns | Description |
|----------|---------|-------------|
| `createLongRunningHarness(config)` | `LongRunningHarness` | Creates a new harness instance |

### Harness Methods

| Method | Signature | Description |
|--------|-----------|-------------|
| `start(plan)` | `(TaskBoardSnapshot) → Promise<Result<StartResult, KoiError>>` | Initialize with task plan, transition to active |
| `resume()` | `() → Promise<Result<ResumeResult, KoiError>>` | Resume from suspended, try engine state then context bridge |
| `pause(result)` | `(SessionResult) → Promise<Result<void, KoiError>>` | End session, persist snapshot, transition to suspended |
| `fail(error)` | `(KoiError) → Promise<Result<void, KoiError>>` | Transition to failed with reason |
| `completeTask(id, result)` | `(TaskItemId, TaskResult) → Promise<Result<void, KoiError>>` | Mark task done; auto-completes if all done |
| `status()` | `() → HarnessStatus` | Sync read of current phase, tasks, metrics |
| `createMiddleware()` | `() → KoiMiddleware` | Returns middleware with 3 hooks |
| `dispose()` | `() → Promise<void>` | Idempotent cleanup, prevents further operations |

### Context Bridge

| Function | Signature | Description |
|----------|-----------|-------------|
| `buildInitialPrompt(plan)` | `(TaskBoardSnapshot) → string` | Formats task plan as text for first session |
| `buildResumeContext(snapshot, config)` | `(HarnessSnapshot, { maxContextTokens }) → Result<InboundMessage[], KoiError>` | Builds pinned resume messages from snapshot |

### Checkpoint Policy

| Function | Signature | Description |
|----------|-----------|-------------|
| `shouldSoftCheckpoint(turn, interval)` | `(number, number) → boolean` | Whether to fire at this turn |
| `computeCheckpointId(harness, session, turn)` | `(HarnessId, string, number) → string` | Deterministic checkpoint ID |

### Types

| Type | Description |
|------|-------------|
| `LongRunningConfig` | Full configuration for harness creation |
| `LongRunningHarness` | Main harness interface with 8 methods |
| `StartResult` | `{ engineInput, sessionId }` |
| `ResumeResult` | `{ engineInput, sessionId, engineStateRecovered }` |
| `SessionResult` | `{ sessionId, engineState?, metrics, summary? }` |
| `SaveStateCallback` | `() → EngineState \| Promise<EngineState>` |
| `DEFAULT_LONG_RUNNING_CONFIG` | Default values for optional config fields |

### L0 Types (from @koi/core)

| Type | Description |
|------|-------------|
| `HarnessId` | Branded string for harness identity |
| `HarnessPhase` | `"idle" \| "active" \| "suspended" \| "completed" \| "failed"` |
| `HarnessSnapshot` | Durable checkpoint: task board, summaries, artifacts, metrics |
| `HarnessStatus` | Observable status: phase, tasks, metrics, failure reason |
| `HarnessMetrics` | Accumulated metrics: sessions, turns, tokens, tasks |
| `ContextSummary` | Per-session narrative with token estimate |
| `KeyArtifact` | Captured tool output with tool name and turn index |
| `HarnessSnapshotStore` | `SnapshotChainStore<HarnessSnapshot>` alias |
| `AgentId` | Branded string for agent identity |

---

## Design Decisions

| Decision | Rationale |
|----------|-----------|
| Harness is a state manager, not middleware | Called at session boundaries by Node — decoupled from engine lifecycle |
| Snapshot chain (DAG) over flat store | Enables branching, forking, and pruning of harness history |
| Resume tries engine state first | Hot path is cheapest — avoids LLM summarization when possible |
| Context bridge messages are `pinned` | Prevents compactor from erasing task plan and summaries |
| Soft checkpoints are fire-and-forget | Checkpoint failures must never block the agent's work |
| Token budget for context bridge | Prevents resume context from consuming entire context window |
| `fail()` separate from `pause()` | Failed state is terminal — prevents accidental resume of broken agents |

---

## Layer Compliance

```
L0  @koi/core ──────────────────────────────────────────────────┐
    HarnessId, HarnessSnapshot, HarnessStatus, HarnessMetrics,   │
    TaskBoardSnapshot, TaskItemId, TaskResult, SessionPersistence, │
    EngineInput, EngineState, InboundMessage, KoiMiddleware,       │
    Result, KoiError                                               │
                                                                    ▼
L2  @koi/long-running <─────────────────────────────────────────┘
    imports from L0 only
    x never imports @koi/engine (L1)
    x never imports peer L2 packages
    x zero external dependencies
    ~ package.json: { "dependencies": { "@koi/core": "workspace:*" } }
```
