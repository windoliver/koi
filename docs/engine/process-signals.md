# Process Signals, Groups, Wait Semantics, and Exit Codes

POSIX-style process control for Koi agents: typed signals, process groups,
`waitpid`-style completion awaiting, and numeric exit codes.

**Layer**: L0 types (`@koi/core`) + L1 runtime (`@koi/engine`)
**Issue**: #627

---

## Overview

Koi agents are modelled after OS processes. This feature completes the analogy
with four primitives taken directly from POSIX:

| POSIX | Koi equivalent |
|-------|---------------|
| `kill -STOP pid` | `handle.signal("stop")` → `suspended` |
| `kill -CONT pid` | `handle.signal("cont")` → `running` |
| `kill -TERM pid` | `handle.signal("term")` → graceful shutdown |
| Process groups | `AgentGroupId` + `signalGroup()` |
| `waitpid()` | `handle.waitForCompletion()` |
| Exit code | `exitCode` on `ChildLifecycleEvent` |

```
Orchestrator
  ├── handle.signal("stop")   → agent suspends at next turn boundary
  ├── handle.signal("cont")   → agent resumes from suspension
  ├── handle.signal("term")   → abort → grace period → force terminate
  └── handle.waitForCompletion() → blocks until terminated, returns exit code

  Process group "batch-workers":
    signalGroup(registry, "batch-workers", "stop")
      ├── worker-1  running → suspended
      ├── worker-2  running → suspended
      └── worker-3  suspended (no-op, already suspended)
```

## Key design decisions

| # | Decision | Choice | Rationale |
|---|----------|--------|-----------|
| 1 | Signal→state wiring | Registry-driven turn-boundary pause | No mid-turn abort for stop/cont — agents finish the current tool call cleanly |
| 2 | Group API placement | Utility functions in L1, not methods on `AgentRegistry` | Registry interface stays minimal; groups are a coordination concern, not a storage concern |
| 3 | Group assignment | `SpawnChildOptions.groupId` + `CreateKoiOptions.groupId` | Runtime grouping — any agent can join any group at spawn time, no manifest change needed |
| 4 | `exitCode` field | Required on `completed` and `terminated` variants | Machine-comparable outcomes; optional would silently drop the field |
| 5 | `exitCodeForTransitionReason()` | Pure function in L0 | Exit codes are derived from transition reasons — no runtime state needed |
| 6 | `term` grace period | `gracePeriodMs` on `createChildHandle()` (default 5 s) | Mirrors `docker stop --time`; abort first, wait, then force |
| 7 | `waitForCompletion` | Method on `ChildHandle` | Callers that need to await a specific child already hold the handle |
| 8 | TransitionReason variants | `signal_stop`, `signal_cont` (new) | Accurate audit trail; `hitl_pause`/`human_approval` are semantically wrong for programmatic signals |
| 9 | `listByGroup` performance | O(n) scan via `matchesFilter()` | Consistent with all other filter operations; groups are expected to be small |
| 10 | `signalGroup` concurrency | `Promise.allSettled()` + configurable deadline | Fan-out all members in parallel; deadline prevents indefinite hang on slow agents |

---

## Architecture

```
┌─────────────────────────┐
│  @koi/core (L0)         │
│                         │
│  AGENT_SIGNALS constant │  "stop" | "cont" | "term" | "usr1" | "usr2"
│  AgentSignal type       │
│  AgentGroupId brand     │  string & { __groupBrand: "AgentGroupId" }
│  agentGroupId()         │
│                         │
│  ChildLifecycleEvent    │  completed { exitCode }
│                         │  terminated { exitCode }
│  ChildCompletionResult  │  { childId, exitCode, reason? }
│  ChildHandle            │  + waitForCompletion()
│                         │
│  TransitionReason       │  + signal_stop | signal_cont
│  RegistryEntry          │  + groupId?
│  RegistryFilter         │  + groupId?
│                         │
│  exitCodeForTransition  │  pure fn: TransitionReason → number
│  Reason()               │
└────────────┬────────────┘
             │ implements
┌────────────▼────────────┐
│  @koi/engine (L1)       │
│                         │
│  child-handle.ts        │  signal dispatch + waitForCompletion
│  group-operations.ts    │  listByGroup + signalGroup
│  koi.ts                 │  turn-boundary suspension check
│  spawn-child.ts         │  groupId + gracePeriodMs threading
└─────────────────────────┘
```

---

## Signal vocabulary

```typescript
import { AGENT_SIGNALS } from "@koi/core";

// AGENT_SIGNALS is a const object — no enum
AGENT_SIGNALS.STOP  // "stop"  → suspended at next turn boundary
AGENT_SIGNALS.CONT  // "cont"  → running (resumes suspended agent)
AGENT_SIGNALS.TERM  // "term"  → graceful shutdown with grace period
AGENT_SIGNALS.USR1  // "usr1"  → application-defined, no state change
AGENT_SIGNALS.USR2  // "usr2"  → application-defined, no state change
```

Signals are dispatched through `ChildHandle.signal()`:

```typescript
// Pause a running agent (turn-boundary — finishes current tool call first)
await handle.signal(AGENT_SIGNALS.STOP);

// Resume a suspended agent
await handle.signal(AGENT_SIGNALS.CONT);

// Graceful terminate: abort signal → 5 s grace → force terminate
await handle.signal(AGENT_SIGNALS.TERM);

// Custom application events (no registry state change)
await handle.signal(AGENT_SIGNALS.USR1);
```

### State machine

```
running ──stop──▶ suspended ──cont──▶ running
                     │
running/waiting ─term─▶ terminated
```

Stop and cont are **idempotent** — signalling a suspended agent with stop (or a
running agent with cont) is a no-op. The registry CAS ensures no spurious
transitions.

### Turn-boundary semantics

Stop does **not** interrupt a running tool call mid-execution. The suspension
check fires at the **start** of each turn iteration in `koi.ts`. If the agent is
suspended, it parks on a reactive Promise that resolves when the registry emits
`to: "running"`:

```
turn N starts → suspension check:
  phase == "suspended"? → park (zero polling, watch-based)
  registry emits transitioned { to: "running" } → unpark
  continue turn N
```

This mirrors POSIX SIGSTOP semantics: the process completes its current syscall
before pausing.

---

## Process groups

Assign agents to a named group at spawn time:

```typescript
import { agentGroupId } from "@koi/core";

const BATCH = agentGroupId("batch-workers");

await koi.spawnChildAgent({
  manifest: workerManifest,
  groupId: BATCH,
});
```

### `listByGroup`

```typescript
import { listByGroup } from "@koi/engine";

const members = await listByGroup(registry, BATCH);
// → readonly RegistryEntry[]  (only agents with groupId === BATCH)
```

Delegates to `registry.list({ groupId })`. The `matchesFilter()` function in L0
filters by exact `groupId` equality. Agents without a `groupId` are excluded.

### `signalGroup`

Fan-out a signal to all active members of a group:

```typescript
import { signalGroup } from "@koi/engine";

// Pause all batch workers
await signalGroup(registry, BATCH, AGENT_SIGNALS.STOP);

// Resume all batch workers
await signalGroup(registry, BATCH, AGENT_SIGNALS.CONT);

// Terminate all batch workers
await signalGroup(registry, BATCH, AGENT_SIGNALS.TERM);
```

**Options:**

```typescript
await signalGroup(registry, BATCH, AGENT_SIGNALS.STOP, {
  // Per-agent ChildHandle map — used instead of direct registry transitions.
  // Necessary for TERM (which requires the abort controller).
  handles: new Map([[agentId("worker-1"), handle1]]),

  // Deadline for the entire fan-out (default: 5000 ms).
  // Rejects with "signalGroup timeout" if exceeded.
  deadlineMs: 10_000,
});
```

**Fan-out semantics:**
- `Promise.allSettled()` — all members are signalled in parallel; one failure
  does not block others.
- Already-terminated agents are skipped before dispatch.
- Without a `ChildHandle`, `TERM` falls back to a direct registry transition
  to `terminated`.

---

## `waitForCompletion`

Wait for a specific child to terminate:

```typescript
const result = await handle.waitForCompletion();
// → { childId, exitCode: number, reason?: TransitionReason }

if (result.exitCode === 0) {
  console.log("child completed successfully");
} else {
  console.log("child failed with exit code", result.exitCode);
}
```

`waitForCompletion` subscribes to `ChildLifecycleEvent` and resolves when the
`terminated` event fires. The listener is unsubscribed immediately after
resolution to prevent leaks.

Multiple concurrent callers all receive the same result:

```typescript
// Both resolve when the agent terminates
const [r1, r2] = await Promise.all([
  handle.waitForCompletion(),
  handle.waitForCompletion(),
]);
```

If the agent has already terminated before `waitForCompletion` is called, it
resolves immediately with `exitCode: 1`.

The noop handle (returned by `spawnChildAgent` when no registry is configured)
resolves immediately with `exitCode: 0`.

---

## Exit codes

Exit codes are derived from the `TransitionReason` that triggered termination:

```typescript
import { exitCodeForTransitionReason } from "@koi/core";

exitCodeForTransitionReason({ kind: "completed" })      // 0 — success
exitCodeForTransitionReason({ kind: "signal_stop" })    // 0 — clean stop/cont cycle
exitCodeForTransitionReason({ kind: "signal_cont" })    // 0
exitCodeForTransitionReason({ kind: "error" })          // 1 — runtime error
exitCodeForTransitionReason({ kind: "budget_exceeded"}) // 2 — resource limit
exitCodeForTransitionReason({ kind: "iteration_limit"}) // 2
exitCodeForTransitionReason({ kind: "timeout" })        // 3 — time limit
exitCodeForTransitionReason({ kind: "evicted" })        // 4 — eviction
exitCodeForTransitionReason({ kind: "stale" })          // 4
exitCodeForTransitionReason({ kind: "escalated" })      // 126 — POSIX convention
```

Exit codes appear on `ChildLifecycleEvent`:

```typescript
handle.onEvent((event) => {
  if (event.kind === "completed" || event.kind === "terminated") {
    console.log("exit code:", event.exitCode);
  }
});
```

---

## Registry integration

`groupId` is stored on `RegistryEntry` and threaded through all registry
implementations:

- **In-memory registry** — filtering via `matchesFilter()`, no extra storage.
- **Nexus registry** — serialized to/from agent metadata (`metadata.groupId`).
- **Event-sourced registry** — included in `agent_registered` event payload,
  folded back on rebuild.

---

## Usage example

```typescript
import { AGENT_SIGNALS, agentGroupId } from "@koi/core";
import { listByGroup, signalGroup } from "@koi/engine";

const RESEARCH_GROUP = agentGroupId("research");

// Spawn agents into a group
const h1 = await koi.spawnChildAgent({ manifest: m1, groupId: RESEARCH_GROUP });
const h2 = await koi.spawnChildAgent({ manifest: m2, groupId: RESEARCH_GROUP });

// Pause all research agents while reviewing intermediate results
await signalGroup(registry, RESEARCH_GROUP, AGENT_SIGNALS.STOP);

// ... inspect results ...

// Resume
await signalGroup(registry, RESEARCH_GROUP, AGENT_SIGNALS.CONT);

// Wait for both to complete
const [r1, r2] = await Promise.all([
  h1.waitForCompletion(),
  h2.waitForCompletion(),
]);

console.log(r1.exitCode, r2.exitCode); // 0, 0
```
