# Idle State & Copilot Reuse

Persistent copilots that survive between tasks via the `"idle"` ProcessState.

**Layer**: L0 (`@koi/core`) types + L1 (`@koi/engine`) runtime
**Files**: `core/src/ecs.ts`, `core/src/lifecycle.ts`, `core/src/assembly.ts`, `engine/src/koi.ts`
**Issue**: [#687](https://github.com/windoliver/koi/issues/687)

---

## Overview

Agents are normally ephemeral: task completes, agent terminates, runtime disposes.
The idle-reuse feature lets a copilot **stay alive between tasks**, automatically
sleeping when idle and waking when new messages arrive in its inbox.

```
created → running → idle → running → idle → ... → terminated
              ↑        ↓       ↑
              task 1   sleep   task 2 (no cold start)
```

One manifest flag enables it:

```yaml
name: my-copilot
lifecycle: copilot    # survives parent death
reuse: true           # go idle instead of terminating
model:
  name: claude-sonnet
```

## What This Enables

- **Persistent copilots** — a copilot forged at runtime (`forge_agent`) keeps its
  full context, middleware state, and forged tools across tasks without
  serialization or cold-start latency.
- **HITL workflows** — the copilot stays alive while waiting for human approval,
  review, or follow-up instead of dying and respawning.
- **Inbox-driven wake** — external systems push messages to the copilot's inbox;
  the engine automatically wakes and processes them.
- **Compose with long-running harness** — the idle state integrates with
  `@koi/long-running` and `@koi/harness-scheduler` for multi-session lifecycle,
  suspension, and checkpoint support.

## ProcessState: "idle"

Added to the `ProcessState` union in `@koi/core`:

```
ProcessState = "created" | "running" | "waiting" | "suspended" | "idle" | "terminated"
```

### Valid Transitions

```
running  → idle         (task_completed_idle)
idle     → running      (inbox_wake)
idle     → terminated   (any termination reason)
```

Invalid transitions from idle: `idle → waiting`, `idle → suspended`, `idle → created`.

### TransitionReasons

| Reason | Transition | Description |
|--------|-----------|-------------|
| `task_completed_idle` | running → idle | Task finished, agent staying alive |
| `inbox_wake` | idle → running | New inbox message triggered wake |

Both return exit code 0 (not errors).

## Engine Behavior (`koi.ts`)

When `manifest.reuse === true` and a task completes normally (`stopReason === "completed"`):

1. **Don't terminate** — skip the `{ kind: "complete" }` transition
2. **Transition to idle** — `agent.transition({ kind: "idle" })`
3. **Poll inbox** — check `inbox.depth() > 0` every 1 second
4. **Wake on message** — when inbox has items, transition back to running
5. **Restart adapter** — create a new adapter stream, drain inbox at turn boundary
6. **Repeat** — the reuse loop continues until abort or error

Errors, timeouts, and `max_turns` always terminate — only normal completion triggers idle.

```
streamEvents() generator:
  try {
    session init
    reuseLoop: while (true) {        ← NEW: outer loop
      adapter = stream(input)
      turnLoop: while (true) {       ← existing turn loop
        suspension check
        inbox drain
        event processing
        if (done && reuse) → break turnLoop → enter idle wait
        if (done && !reuse) → transition(complete) → return
      }
      // Idle wait
      transition(idle)
      poll inbox every 1s (unref'd timer)
      also watch registry for external wake
      transition(resume)
      continue reuseLoop               ← restart with new adapter
    }
  } finally {
    cleanup (handles both running and idle states)
  }
```

### Performance

- **Idle polling**: `setInterval` at 1s with `.unref()` — does not keep the
  process alive. The `depth()` check is O(1).
- **Registry watch**: event-driven (zero polling). Fires on any registry
  transition targeting this agent.
- **No busy-wait**: the idle Promise parks the generator. CPU cost is near-zero.
- **Cleanup**: timer and registry subscription are cleaned up on wake or abort.

### ChildLifecycleEvents

Parent agents observe copilot idle/wake via `ChildHandle`:

```typescript
childHandle.onEvent((event) => {
  event.kind === "idled"  // copilot went idle
  event.kind === "woke"   // copilot resumed
});
```

## Manifest Configuration

```typescript
interface AgentManifest {
  // ... existing fields ...
  readonly lifecycle?: "copilot" | "worker" | undefined;
  readonly reuse?: boolean | undefined;
}
```

| Field | Value | Effect |
|-------|-------|--------|
| `lifecycle` | `"copilot"` | Survives parent death (existing) |
| `reuse` | `true` | Goes idle after task instead of terminating (new) |

Both flags together create a persistent copilot. `reuse` without `lifecycle: "copilot"`
creates a reusable worker (still terminated by parent cascade).

## Comparison with OpenClaw

| Aspect | Koi (idle-reuse) | OpenClaw (Heartbeat) |
|--------|-----------------|---------------------|
| Between tasks | Process alive, state in memory | Process dead, state on filesystem |
| Wake trigger | Inbox push (< 1s latency) | Cron job (default 30min) |
| Context | Hot — runtime, tools, middleware preserved | Cold — reload from disk each time |
| Cost while idle | Near-zero (unref'd timer) | Zero (no process) |
| Trade-off | Memory usage | Cold-start latency |
