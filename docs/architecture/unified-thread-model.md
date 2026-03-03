# Unified Thread/Checkpoint Model

Replaces three separate agent execution systems (single-shot `koi.run()`, long-running harness, harness scheduler) with one unified thread primitive. An agent adds `threadStore` to get checkpoints, inbox messaging, and self-escalation to autonomous mode — all auto-wired.

---

## Problem

Before this change, Koi had three disconnected execution models:

| Mode | What it did | Limitation |
|------|-------------|------------|
| `koi.run()` | Single-shot execution | No memory between calls |
| Long-running harness | Multi-session lifecycle | 30+ lines of manual wiring |
| Harness scheduler | Auto-resume after suspension | Even more wiring on top of harness |

No way to send messages to a running agent. No way for an agent to self-escalate from chat to autonomous mode. No unified persistence model.

## Solution

One `threadStore` field activates everything:

```typescript
const agent = createAutonomousAgent({
  harness,
  scheduler,
  threadStore: myStore,
});

// Auto-wired: checkpoint + inbox + plan_autonomous tool
const runtime = await createKoi({
  manifest,
  adapter,
  middleware: agent.middleware(),
  providers: agent.providers(),
});
```

---

## What It Enables

### 1. LLM Self-Escalation

The agent can call `plan_autonomous` to break a complex task into subtasks and enter autonomous mode — no human trigger needed.

```
Human: "Refactor auth to use JWT"

LLM calls plan_autonomous({
  tasks: [
    { id: "research", description: "Find best JWT library" },
    { id: "impl", description: "Implement JWT middleware", dependencies: ["research"] },
    { id: "test", description: "Write tests", dependencies: ["research"] },
    { id: "docs", description: "Update API docs", dependencies: ["impl", "test"] },
  ]
})
```

- `research` runs first
- `impl` and `test` run in parallel (no dependency on each other)
- `docs` waits for both to finish
- Progress checkpointed automatically

### 2. Automatic Checkpointing

State persists every N turns (default: 5, configurable). Survives crashes, restarts, and session boundaries.

```typescript
// Configurable policy
const agent = createAutonomousAgent({
  harness,
  scheduler,
  threadStore: myStore,
  checkpointPolicy: { intervalTurns: 3, onSessionEnd: true, onSuspend: true },
});
```

### 3. Mid-Run Messaging (Inbox)

External systems can send messages to a running agent. Three modes:

| Mode | Behavior | Cap |
|------|----------|-----|
| `steer` | Inject immediately at next turn boundary | 1 |
| `collect` | Batch for next turn context | 20 |
| `followup` | Queue for later processing | 50 |

```typescript
inbox.push({
  id: "urgent-1",
  from: agentId("ops-team"),
  mode: "steer",
  content: "Drop current task, fix the prod outage",
  priority: 10,
  createdAt: Date.now(),
});
```

### 4. Unified Persistence

Two snapshot kinds coexist in the same chain:

```typescript
type ThreadSnapshot =
  | MessageThreadSnapshot   // chat-style conversation history
  | HarnessThreadSnapshot;  // autonomous task board + metrics
```

Both share a `ThreadStore` facade over `SnapshotChainStore<ThreadSnapshot>`, with idempotent append (duplicate message IDs are rejected).

### 5. Thread Compaction

Old message snapshots are pruned to bound storage growth:

```typescript
const compactor = createThreadCompactor({
  retainMessageSnapshots: 50,  // keep last 50
  compactOlder: true,          // fold older into summaries
});
```

### 6. Unified Spawn Interface

All agent-spawning patterns use one `SpawnFn` signature:

```typescript
type SpawnFn = (request: SpawnRequest) => Promise<SpawnResult>;
```

Each L2 package provides a thin adapter: `mapSpawnToMinion`, `mapSpawnToTask`, `mapSpawnToWorker`. Middleware and governance operate on one interface.

---

## Architecture

### Layer Allocation

```
L0  @koi/core           Types: ThreadSnapshot, InboxComponent, SpawnFn,
                         CheckpointPolicy, ThreadStore, INBOX token

L1  @koi/engine          createInboxQueue(), inbox drain in run loop

L0u @koi/snapshot-chain-store  createThreadStore() facade
    @koi/test-utils            createFakeEngineAdapter(), contract tests

L2  @koi/long-running    createCheckpointMiddleware()
                         createInboxMiddleware()
                         createPlanAutonomousProvider()
                         createTaskTools()
                         createAutonomousProvider()
                         createThreadCompactor()

L2  @koi/parallel-minions  mapSpawnToMinion()
    @koi/task-spawn         mapSpawnToTask()
    @koi/orchestrator       mapSpawnToWorker()

L3  @koi/autonomous      Extended createAutonomousAgent() — wires everything
```

### Data Flow

```
Human message
  │
  ▼
┌─────────────────────────────────────────────────────────┐
│  Engine (koi.ts)                                        │
│                                                         │
│  ┌─ onBeforeTurn ──────────────────────────────┐       │
│  │  inbox-middleware (priority 45)              │       │
│  │    MailboxComponent → InboxComponent         │       │
│  │    routes by metadata.mode                   │       │
│  └─────────────────────────────────────────────┘       │
│                                                         │
│  ┌─ Turn executes ─────────────────────────────┐       │
│  │  LLM generates response                     │       │
│  │  May call: plan_autonomous, task_complete,   │       │
│  │            task_update, task_status           │       │
│  └─────────────────────────────────────────────┘       │
│                                                         │
│  ┌─ Turn boundary ─────────────────────────────┐       │
│  │  Inbox drain:                                │       │
│  │    steer  → adapter.inject() (immediate)     │       │
│  │    collect/followup → next turn context       │       │
│  └─────────────────────────────────────────────┘       │
│                                                         │
│  ┌─ onAfterTurn ───────────────────────────────┐       │
│  │  checkpoint-middleware (priority 55)          │       │
│  │    fires every N turns → persist snapshot     │       │
│  └─────────────────────────────────────────────┘       │
└─────────────────────────────────────────────────────────┘
```

---

## Tools Available to the LLM

### `plan_autonomous`

Self-escalation tool. The LLM calls this to create a task board and enter autonomous mode.

| Field | Description |
|-------|-------------|
| `tasks[].id` | Unique slug (e.g. `"research"`, `"impl"`) |
| `tasks[].description` | Clear, actionable instruction with expected output |
| `tasks[].dependencies` | IDs of tasks that must complete first. Omit for immediate execution. Tasks without shared dependencies run in parallel. |

### `task_complete`

Mark a task as done. Output is passed to downstream dependent tasks.

| Field | Description |
|-------|-------------|
| `task_id` | ID from `plan_autonomous` |
| `output` | Summary of results, file paths, findings |

Returns remaining task count; when 0, autonomous execution ends.

### `task_update`

Revise a task's description based on findings from earlier tasks.

### `task_status`

Check progress: counts by status (pending, assigned, completed, failed) and full task list.

---

## 16 Architectural Decisions

| # | Decision | Choice |
|---|----------|--------|
| 1 | ThreadStore persistence | Thin facade over `SnapshotChainStore<ThreadSnapshot>` |
| 2 | Background state model | `AgentCondition: "BackgroundWork"` |
| 3 | Inbox layer allocation | Types L0, queue L1, steer via optional `EngineAdapter.inject?()` |
| 4 | Middleware decomposition | Thin middleware + ComponentProvider for ECS state |
| 5 | Spawn type unification | Unified `SpawnFn/SpawnRequest/SpawnResult` in `@koi/core` |
| 6 | Thread idempotency | `ThreadMessage.id` is idempotency key, CAS retry |
| 7 | Tool lifecycle | `plan_autonomous` at assembly; task tools via `ForgeRuntime.registerTool()` |
| 8 | State coexistence | Discriminated union `ThreadSnapshot = message \| harness` |
| 9 | Queue testing | Unit + integration with `FakeEngineAdapter` |
| 10 | Store testing | Reusable `runThreadStoreContractTests` |
| 11 | Lifecycle testing | Unit state machine + integration with real gates |
| 12 | Deprecation safety | API surface snapshot tests |
| 13 | Chain scaling | Prune + compaction window (keep last 50, summarize older) |
| 14 | Queue bounds | Per-mode caps: collect=20, followup=50, steer=1 |
| 15 | Checkpoint frequency | Configurable `CheckpointPolicy`, default 5 turns |
| 16 | Tool registration overhead | Non-issue, accepted |

---

## Files Added/Modified

### New Files (14)

| File | LOC | Purpose |
|------|-----|---------|
| `packages/core/src/thread.ts` | ~200 | L0 types: ThreadSnapshot, ThreadStore, CheckpointPolicy |
| `packages/core/src/inbox.ts` | ~90 | L0 types: InboxComponent, InboxPolicy, InboxItem |
| `packages/core/src/spawn.ts` | ~65 | L0 types: SpawnFn, SpawnRequest, SpawnResult |
| `packages/snapshot-chain-store/src/thread-store.ts` | ~120 | ThreadStore facade |
| `packages/engine/src/inbox-queue.ts` | ~75 | In-memory inbox queue with per-mode caps |
| `packages/test-utils/src/thread-store-contract.ts` | ~130 | Reusable contract test suite |
| `packages/test-utils/src/fake-engine-adapter.ts` | ~70 | Pre-scripted engine adapter for tests |
| `packages/long-running/src/plan-autonomous-tool.ts` | ~140 | plan_autonomous tool provider |
| `packages/long-running/src/task-tools.ts` | ~140 | task_complete, task_update, task_status tools |
| `packages/long-running/src/checkpoint-middleware.ts` | ~65 | Checkpoint at configurable intervals |
| `packages/long-running/src/autonomous-provider.ts` | ~50 | Attaches InboxComponent via INBOX token |
| `packages/long-running/src/inbox-middleware.ts` | ~95 | Routes MailboxComponent → InboxComponent |
| `packages/long-running/src/thread-compactor.ts` | ~130 | Prunes old snapshots into summaries |
| `packages/*/src/spawn-adapter.ts` | ~30 each | Spawn adapters (3 files) |

### Modified Files (7)

| File | Change |
|------|--------|
| `packages/core/src/lifecycle.ts` | Added `"BackgroundWork"` to AgentCondition |
| `packages/core/src/engine.ts` | Added optional `inject?()` to EngineAdapter |
| `packages/core/src/ecs.ts` | Added INBOX token |
| `packages/core/src/index.ts` | New exports |
| `packages/engine/src/koi.ts` | Inbox drain at turn boundary |
| `packages/autonomous/src/types.ts` | Added threadStore, checkpointPolicy, inboxPolicy |
| `packages/autonomous/src/autonomous.ts` | Auto-wires checkpoint + inbox + providers |

### Test Files (10)

727 tests across all affected packages, 0 failures.
