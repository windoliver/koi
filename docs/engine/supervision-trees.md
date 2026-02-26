# Supervision Trees

Erlang/OTP-style hierarchical fault recovery for Koi agents.

**Layer**: L0 types (`@koi/core`) + L1 runtime (`@koi/engine`)
**Issue**: #257

---

## Overview

When a spawned child agent terminates, the supervision system automatically
restarts it based on the parent's declared strategy — no manual intervention.
If restarts keep failing, the supervisor escalates by terminating itself,
propagating the failure upward through the process tree.

```
┌─────────────────┐
│   Supervisor    │  manifest.supervision:
│   (parent)      │    strategy: one_for_one
└────────┬────────┘    maxRestarts: 5
         │             maxRestartWindowMs: 60000
    ┌────┼────┐        children:
    ▼    ▼    ▼          - name: researcher, restart: permanent
   A    B    C           - name: writer,     restart: transient
                         - name: logger,     restart: temporary

   B crashes → reconciler detects → restarts B' → work continues
```

## Key design decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Restart model | New agent entity (Erlang model) | `terminated` stays absorbing — no zombie states |
| Where types live | L0 types + L1 reconciler | Clean layer separation |
| Strategy location | Parent manifest | Parent owns the restart policy, not the child |
| Cascading termination | Supervision-aware | Defers cascade for supervised children |
| Restart order | Sequential in declaration order | Predictable dependency ordering |
| Restart budget | Per-child ring buffer | Independent tracking, sliding window |

---

## Architecture

### Components

```
┌─────────────┐     ┌──────────────────┐     ┌──────────────────┐
│ @koi/core   │     │ @koi/engine      │     │ @koi/engine      │
│             │     │                  │     │                  │
│ Supervision │────►│ Supervision      │────►│ Reconcile        │
│ Config      │     │ Reconciler       │     │ Runner           │
│ ChildSpec   │     │                  │     │ (tick loop)      │
│ RestartType │     │ Restart          │     │                  │
│ Strategy    │     │ Intensity        │     │ Cascading        │
│             │     │ Tracker          │     │ Termination      │
└─────────────┘     └──────────────────┘     └──────────────────┘
```

### Reconciliation loop

The `SupervisionReconciler` implements the `ReconciliationController`
interface and runs inside the `ReconcileRunner` alongside health,
timeout, and tool reconcilers:

```
ReconcileRunner (ticks every ~100ms)
│
├─ HealthReconciler.reconcile(agentId)
├─ TimeoutReconciler.reconcile(agentId)
├─ ToolReconciler.reconcile(agentId)
└─ SupervisionReconciler.reconcile(agentId)   ◄── new
```

Each tick, the supervision reconciler:

1. Checks if the agent has `manifest.supervision` — early return if not
2. Looks up children in the `ProcessTree`
3. For each terminated child, evaluates restart policy
4. Applies the declared strategy (restart, terminate siblings, etc.)
5. Returns `converged` or `retry`

---

## L0 Types (`@koi/core/supervision.ts`)

### SupervisionStrategy

```typescript
type SupervisionStrategy =
  | { readonly kind: "one_for_one" }
  | { readonly kind: "one_for_all" }
  | { readonly kind: "rest_for_one" };
```

### RestartType

```typescript
type RestartType = "permanent" | "transient" | "temporary";
```

| Type | Behavior |
|------|----------|
| `permanent` | Always restart on termination |
| `transient` | Restart only on abnormal exit (error, stale) |
| `temporary` | Never restart (fire-and-forget) |

### ChildSpec

```typescript
interface ChildSpec {
  readonly name: string;
  readonly restart: RestartType;
  readonly shutdownTimeoutMs?: number;  // default 5000
}
```

### SupervisionConfig

```typescript
interface SupervisionConfig {
  readonly strategy: SupervisionStrategy;
  readonly maxRestarts: number;        // default 5
  readonly maxRestartWindowMs: number;  // default 60_000
  readonly children: readonly ChildSpec[];
}
```

Declared on the parent's `AgentManifest.supervision` field.

### TransitionReason additions

Two new `TransitionReason` kinds:

```typescript
| { readonly kind: "restarted"; readonly attempt: number; readonly strategy: string }
| { readonly kind: "escalated"; readonly cause: string }
```

---

## L1 Runtime (`@koi/engine`)

### SupervisionReconciler

Factory: `createSupervisionReconciler(deps)`

```typescript
function createSupervisionReconciler(deps: {
  readonly registry: AgentRegistry;
  readonly processTree: ProcessTree;
  readonly spawnChild: SpawnChildFn;
  readonly clock?: Clock;
}): SupervisionReconciler;
```

The reconciler maintains an internal `childSpecName → currentAgentId` mapping
that updates on each restart (since a restart spawns a new agent entity with
a new ID).

#### Reconcile flow

```
reconcile(supervisorId)
│
├─ no manifest.supervision? → return converged
│
├─ for each childSpec in declaration order:
│   │
│   ├─ child alive? → skip
│   │
│   ├─ child terminated?
│   │   ├─ restart = "temporary"  → skip (never restart)
│   │   ├─ restart = "transient" + normal exit → skip
│   │   └─ restart needed:
│   │       │
│   │       ├─ budget exhausted? → ESCALATE
│   │       │   (terminate supervisor with reason "escalated")
│   │       │
│   │       └─ budget OK → apply strategy
│   │
│   └─ strategy application:
│       ├─ one_for_one  → restart only this child
│       ├─ one_for_all  → terminate all, restart all
│       └─ rest_for_one → terminate this + later, restart this + later
│
└─ return converged | retry
```

### RestartIntensityTracker

Factory: `createRestartIntensityTracker(config)`

```typescript
function createRestartIntensityTracker(config: {
  readonly maxRestarts: number;
  readonly windowMs: number;
  readonly clock: Clock;
}): RestartIntensityTracker;
```

Per-child ring buffer of timestamps. Tracks restart attempts within a
sliding time window to prevent restart storms.

```typescript
interface RestartIntensityTracker {
  readonly record: (childName: string, now: number) => void;
  readonly isExhausted: (childName: string, now: number) => boolean;
  readonly attemptsInWindow: (childName: string, now: number) => number;
  readonly reset: (childName: string) => void;
}
```

**Budget exhaustion**: when `attemptsInWindow >= maxRestarts`, the supervisor
cannot restart and must escalate.

**Budget recovery**: as time passes, old entries slide out of the window,
freeing budget for future restarts.

```
Ring buffer (maxRestarts = 3, windowMs = 60s):

  [t=10s]  [t=25s]  [t=41s]     ← 3 entries, 3 in window at t=42s
                                    → exhausted!

  At t=71s: [t=10s] slides out   ← 2 in window
                                    → budget recovered
```

### CascadingTermination (supervision-aware)

Factory: `createCascadingTermination(registry, tree, isSupervised?)`

```typescript
function createCascadingTermination(
  registry: AgentRegistry,
  tree: ProcessTree,
  isSupervised?: (agentId: AgentId) => boolean,
): CascadingTermination;
```

When a supervised child terminates, cascading to its descendants is
**deferred** to the supervision reconciler (which may restart the child
and preserve the grandchildren). When a supervisor itself terminates,
cascading proceeds as normal.

```
Without supervision-awareness:     With supervision-awareness:

child dies                         child dies
  → kill grandchildren               → isSupervised(child)?
  → unrecoverable                     ├─ YES → defer to reconciler
                                      └─ NO  → cascade as before
```

---

## Strategies in detail

### `one_for_one`

Only the terminated child restarts. Other children are unaffected.
Use when children are independent.

```
Before:  A(ok)   B(dead)  C(ok)
After:   A(ok)   B'(new)  C(ok)
```

### `one_for_all`

All children terminate and restart in declaration order.
Use when children share state or have tight coupling.

```
Before:  A(ok)   B(dead)  C(ok)
Step 1:  A(stop) B(dead)  C(stop)    ← terminate all
Step 2:  A'(new) B'(new)  C'(new)    ← restart all in order
```

### `rest_for_one`

The terminated child and all children declared after it restart.
Use when children have sequential dependencies (B depends on A, C on B).

```
Declaration order: A, B, C

B dies:
Before:  A(ok)   B(dead)  C(ok)
Step 1:  A(ok)   B(dead)  C(stop)    ← terminate C (declared after B)
Step 2:  A(ok)   B'(new)  C'(new)    ← restart B, C in order
```

---

## Escalation

When the restart budget is exhausted (e.g., 5 restarts within 60 seconds),
the supervisor terminates itself with reason `{ kind: "escalated" }`.

This propagates the failure upward. If the supervisor's parent is also
supervised, that grandparent's reconciler will detect the failure and
apply its own strategy — enabling hierarchical fault isolation.

```
┌───────────────────┐
│ Grand-Supervisor  │  detects supervisor died
│                   │  applies ITS strategy
└────────┬──────────┘
         │
         ▼
┌─────────────┐
│ Supervisor' │  new entity, fresh restart budget
└──────┬──────┘
       │
  ┌────┼────┐
  ▼    ▼    ▼
 A'   B'   C'   all fresh
```

If there is no grandparent supervisor, the terminated supervisor stays
dead (standard cascading termination cleans up descendants).

---

## Manifest example

```yaml
name: project-manager
model: claude-sonnet
supervision:
  strategy:
    kind: one_for_one
  maxRestarts: 5
  maxRestartWindowMs: 60000
  children:
    - name: researcher
      restart: permanent
    - name: coder
      restart: permanent
    - name: reviewer
      restart: transient
    - name: formatter
      restart: temporary
```

| Child | Behavior |
|-------|----------|
| researcher | Always restarted on any termination |
| coder | Always restarted on any termination |
| reviewer | Restarted only on abnormal exit (error, rate limit, crash) |
| formatter | Never restarted (one-shot task) |

---

## Source files

| File | Purpose |
|------|---------|
| `packages/core/src/supervision.ts` | L0 types: strategies, child specs, config |
| `packages/core/src/assembly.ts` | `AgentManifest.supervision` field |
| `packages/core/src/lifecycle.ts` | `restarted` + `escalated` transition reasons |
| `packages/engine/src/supervision-reconciler.ts` | Reconciliation controller |
| `packages/engine/src/restart-intensity.ts` | Per-child ring buffer tracker |
| `packages/engine/src/cascading-termination.ts` | Supervision-aware cascade |

### Tests

| File | Cases |
|------|-------|
| `packages/engine/src/restart-intensity.test.ts` | 8 unit tests |
| `packages/engine/src/__tests__/supervision-reconciler.integration.test.ts` | 24 integration tests |
| `packages/engine/src/__tests__/supervision-e2e.test.ts` | 8 E2E tests |
| `packages/engine/src/cascading-termination.test.ts` | 4 new supervision cases |

---

## Relationship to other subsystems

```
                  ┌──────────────┐
                  │ AgentManifest│  declares supervision config
                  └──────┬───────┘
                         │
              ┌──────────┼───────────────┐
              ▼          ▼               ▼
     ┌────────────┐ ┌──────────┐ ┌────────────────┐
     │ Process    │ │ Agent    │ │ Reconcile      │
     │ Tree       │ │ Registry │ │ Runner         │
     │            │ │          │ │                │
     │ parent →   │ │ CAS      │ │ ticks every   │
     │ children   │ │ lifecycle│ │ ~100ms         │
     │ queries    │ │ transitions│ │              │
     └─────┬──────┘ └────┬─────┘ └───────┬──────┘
           │              │               │
           └──────────────┼───────────────┘
                          │
                          ▼
               ┌─────────────────────┐
               │ Supervision         │
               │ Reconciler          │
               │                     │
               │ + RestartIntensity  │
               │   Tracker           │
               │                     │
               │ + Cascading         │
               │   Termination       │
               │   (supervision-     │
               │    aware)           │
               └─────────────────────┘
```

## Comparison with Erlang/OTP

| Concept | Erlang/OTP | Koi |
|---------|------------|-----|
| Supervisor | `supervisor` behaviour | Agent with `manifest.supervision` |
| Child spec | `child_spec()` | `ChildSpec` type |
| Restart strategy | `one_for_one` etc. | `SupervisionStrategy` discriminated union |
| Max restarts | `intensity` + `period` | `maxRestarts` + `maxRestartWindowMs` |
| Restart type | `permanent / transient / temporary` | Same names, same semantics |
| Process | Erlang process (lightweight) | `AgentEntity` (heavier, LLM-backed) |
| Escalation | Supervisor exits → parent handles | Same: terminate self with `escalated` reason |
| Restart | Same PID, new state | New agent entity, new `AgentId` |
