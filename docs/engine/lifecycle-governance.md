# Lifecycle Governance

Declarative agent lifecycle types, selective cascade termination, spawner lineage, and active parent control.

**Layer**: L0 types (`@koi/core`) + L1 runtime (`@koi/engine`)
**Issue**: #393

---

## Overview

Before lifecycle governance, all spawned agents were implicitly typed at runtime
and cascade-terminated identically when a parent died. There was no way for a
parent to selectively signal or terminate individual children, no way to declare
"this child should survive my death", and no provenance tracking for
copilot-forging-copilot scenarios.

Lifecycle governance makes agent behavior **manifest-driven**: a single YAML
field (`lifecycle: "copilot" | "worker"`) determines whether a child survives
parent death or cascade-terminates with it, gives parents active control
(`signal` + `terminate`), and tracks spawner provenance for lineage queries.

```
  Parent (copilot)
  ├── Planner  (lifecycle: "copilot")   ← survives parent death
  │     └── Researcher (worker)          ← subtree also survives (skipped)
  ├── Coder    (lifecycle: "worker")    ← cascade-terminated with parent
  │     └── Tester (worker)              ← also cascade-terminated
  └── Reviewer (lifecycle: "copilot")   ← survives parent death

  Parent TERMINATES:
    Planner     [ALIVE]     copilot → skipped by cascade BFS
    Researcher  [ALIVE]     Planner's subtree never visited
    Coder       [DEAD]      worker → evicted
    Tester      [DEAD]      Coder's child → evicted
    Reviewer    [ALIVE]     copilot → skipped
```

## Key design decisions

| # | Decision | Choice | Rationale |
|---|----------|--------|-----------|
| 1 | Manifest lifecycle field | `lifecycle?: "copilot" \| "worker"` | Manifest is the single source of truth; no runtime inference needed |
| 2 | ChildHandle design | Modify existing `ChildHandle` with `signal` + `terminate` | No new concept — extends what's already there |
| 3 | Cascade behavior | Skip copilots + their entire subtrees | Copilot independence means the subtree is the copilot's responsibility |
| 4 | Lineage tracking | `spawner` on `RegistryEntry`, `lineage()` on `ProcessTree` | Immutable provenance at L0, query at L1 |
| 5 | agentType source | Manifest-driven, removed from `CreateKoiOptions` | One source of truth, no conflicting overrides |
| 6 | Signal mechanism | AbortController owned by `spawnChildAgent` | Standard platform API, no new abstraction |
| 7 | Terminate idempotency | No-op if already terminated, retry once on CAS conflict | Safe to call multiple times |
| 8 | Event ordering | `completed`/`error` fires before `terminated` | Callers see the reason before cleanup |
| 9 | Async cascade | Always-await (removed `isPromise` branching) | Uniform code path, no sync/async split |

---

## Architecture

### How lifecycle type flows through the system

```
manifest.yaml                 createKoi()               ProcessId
┌──────────────┐             ┌─────────────┐           ┌──────────────┐
│ lifecycle:   │────────────►│ generatePid()│──────────►│ type: "worker│
│   "worker"   │             │              │           │    "copilot" │
└──────────────┘             │ priority:    │           └──────────────┘
                             │ 1. manifest  │
                             │ 2. inference │
                             └─────────────┘
                                    │
                             inference fallback:
                             parent exists? → "worker"
                             no parent?     → "copilot"
```

### Parent-child control surface

```
┌──────────────────────────────────────────────────────────┐
│  Parent Agent                                            │
│                                                          │
│  const { handle } = await spawnChildAgent(...)           │
│                                                          │
│  handle.onEvent(e => {                                   │
│    "started"     → child transitioned to running         │
│    "completed"   → child finished successfully           │
│    "error"       → child failed (e.cause available)      │
│    "signaled"    → echo of signal sent by parent         │
│    "terminated"  → child is dead (final event)           │
│  });                                                     │
│                                                          │
│  handle.signal("graceful_shutdown")  → soft nudge        │
│  handle.terminate()                  → CAS hard kill     │
└──────────────────────────────────────────────────────────┘
         │                              │
         │ signal                       │ terminate
         ▼                              ▼
  AbortController.abort()       registry.transition(
                                  childId, "terminated",
                                  generation, { kind: "evicted" }
                                )
```

### Cascading termination — copilot-aware BFS

```
cascadeTerminate(parent):
│
│  queue = childrenOf(parent)
│
│  while queue not empty:
│    child = dequeue
│    │
│    ├─ entry.agentType === "copilot"?
│    │   YES → skip (don't enqueue children)    ← copilot subtree pruned
│    │
│    ├─ already terminated?
│    │   YES → skip
│    │
│    └─ NO → transition to "terminated" { kind: "evicted" }
│            enqueue childrenOf(child)
```

### Spawner lineage

```
  Research Agent ──spawns──► Planning Agent ──spawns──► Worker

  RegistryEntry (Worker):
    spawner: "Planning Agent"

  ProcessTree.lineage("Worker"):
    → ["Planning Agent", "Research Agent"]

  Walk: Worker.spawner → Planning.spawner → Research (no spawner) → stop
```

---

## L0 Types (`@koi/core`)

### AgentManifest — `lifecycle` field

```typescript
// packages/core/src/assembly.ts
interface AgentManifest {
  // ... existing fields ...
  readonly lifecycle?: "copilot" | "worker" | undefined;
}
```

| Value | Behavior |
|-------|----------|
| `"copilot"` | Survives parent death. Subtree skipped during cascade. |
| `"worker"` | Cascade-terminated when parent dies. |
| `undefined` | Inferred: `"worker"` if spawned (has parent), `"copilot"` if top-level. |

### ChildHandle — `signal()` + `terminate()`

```typescript
// packages/core/src/ecs.ts
interface ChildHandle {
  readonly childId: AgentId;
  readonly name: string;
  readonly onEvent: (listener: (event: ChildLifecycleEvent) => void) => () => void;
  readonly signal: (kind: string) => void | Promise<void>;
  readonly terminate: (reason?: string) => void | Promise<void>;
}
```

### ChildLifecycleEvent — 5 kinds

```typescript
// packages/core/src/ecs.ts
type ChildLifecycleEvent =
  | { readonly kind: "started";    readonly childId: AgentId }
  | { readonly kind: "completed";  readonly childId: AgentId }
  | { readonly kind: "error";      readonly childId: AgentId; readonly cause?: unknown }
  | { readonly kind: "signaled";   readonly childId: AgentId; readonly signal: string }
  | { readonly kind: "terminated"; readonly childId: AgentId };
```

Event ordering when a child terminates with reason `"completed"`:
```
started → completed → terminated
```

Event ordering when a child terminates with reason `"error"`:
```
started → error (cause: ...) → terminated
```

### RegistryEntry — `spawner` field

```typescript
// packages/core/src/lifecycle.ts
interface RegistryEntry {
  // ... existing fields ...
  readonly spawner?: AgentId;  // immutable provenance, set once at registration
}
```

### AgentRegisteredEvent — `spawner` propagation

```typescript
// packages/core/src/agent-state-event.ts
interface AgentRegisteredEvent {
  readonly kind: "agent_registered";
  readonly agentId: AgentId;
  readonly agentType: "copilot" | "worker";
  readonly parentId?: AgentId | undefined;
  readonly spawner?: AgentId | undefined;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly registeredAt: number;
}
```

The `evolveRegistryEntry` fold function propagates `spawner` into the projected
`RegistryEntry` on registration events.

---

## L1 Runtime (`@koi/engine`)

### generatePid — manifest-driven

```typescript
// packages/engine/src/koi.ts
function generatePid(
  manifest: { readonly name: string; readonly lifecycle?: "copilot" | "worker" | undefined },
  options?: { readonly parent?: ProcessId },
): ProcessId {
  const agentType = manifest.lifecycle ?? (options?.parent !== undefined ? "worker" : "copilot");
  // ... rest of PID construction
}
```

Priority:
1. `manifest.lifecycle` — explicit declaration wins
2. Parent exists → `"worker"` (spawned child defaults to worker)
3. No parent → `"copilot"` (top-level defaults to copilot)

### spawnChildAgent — full wiring

```typescript
// packages/engine/src/spawn-child.ts
async function spawnChildAgent(options: SpawnChildOptions): Promise<SpawnResult>
```

Spawn sequence:
```
1. Acquire ledger slot
2. Build InheritedComponentProvider (scope-filtered parent tools)
3. Create AbortController (for signal support)
4. createKoi({ manifest, parentPid, ... })
   └─ generatePid reads manifest.lifecycle
5. registry.register({ ..., spawner: parent.pid.id })
6. createChildHandle(childId, name, registry, abortController)
7. Wire termination → ledger release (idempotency guard)
```

Key details:
- `agentType` removed from `CreateKoiOptions` — manifest is the only source
- `spawner` set to `parentAgent.pid.id` at registration
- Idempotency flag (`let released = false`) prevents double ledger release

### createChildHandle — signal, terminate, event mapping

```typescript
// packages/engine/src/child-handle.ts
function createChildHandle(
  childId: AgentId,
  name: string,
  registry: AgentRegistry,
  abortController?: AbortController,
): ChildHandle
```

| Method | Behavior |
|--------|----------|
| `signal(kind)` | Emits `"signaled"` event to listeners, calls `abortController.abort(kind)` |
| `terminate()` | CAS-transitions to `"terminated"`. Retries once on `CONFLICT`. No-op if already terminated. |

Registry watcher maps transitions to events:
```
created → running           → "started"
→ terminated (completed)    → "completed" then "terminated"
→ terminated (error)        → "error" then "terminated"
deregistered                → "terminated"
```

### CascadingTermination — copilot-aware BFS

```typescript
// packages/engine/src/cascading-termination.ts
function createCascadingTermination(
  registry: AgentRegistry,
  tree: ProcessTree,
  isSupervised?: (agentId: AgentId) => boolean,
): CascadingTermination
```

Inline BFS avoids `descendantsOf()` to support copilot subtree pruning:
- Copilot children are **not enqueued** → their subtrees are never visited
- Worker children are CAS-transitioned to terminated, then their children enqueued
- Always-await pattern — no `isPromise()` branching
- Supervision-aware: defers to reconciler for supervised children

### ProcessTree — spawner tracking + lineage

```typescript
// packages/engine/src/process-tree.ts
interface ProcessTree extends AsyncDisposable {
  // ... existing methods ...
  readonly lineage: (id: AgentId) => readonly AgentId[];
}
```

Internal `spawnerMap: Map<string, AgentId>` populated from `RegistryEntry.spawner`
on registration events. The `lineage()` method walks the spawner chain upward:

```typescript
function lineage(id: AgentId): readonly AgentId[] {
  const result: AgentId[] = [];
  let current = spawnerMap.get(id);
  while (current !== undefined) {
    result.push(current);
    current = spawnerMap.get(current);
  }
  return result;
}
```

Returns `[spawner, spawner's spawner, ..., root]` or empty array for root agents.

---

## Manifest example

```yaml
# Worker child — dies with parent
name: data-fetcher
lifecycle: worker
model:
  name: claude-haiku

# Copilot child — survives parent death
name: research-assistant
lifecycle: copilot
model:
  name: claude-sonnet
```

### Mixed swarm topology

```yaml
# Orchestrator manifest (top-level, no lifecycle field → defaults to copilot)
name: orchestrator
model:
  name: claude-sonnet
supervision:
  strategy:
    kind: one_for_one
  maxRestarts: 3
  children:
    - name: planner
      restart: permanent
    - name: coder
      restart: transient
```

Children declared with their own manifests:

```yaml
# Planner — survives independently
name: planner
lifecycle: copilot
model:
  name: claude-sonnet

# Coder — ephemeral worker
name: coder
lifecycle: worker
model:
  name: claude-haiku
```

---

## Scenarios

### 1. Copilot forging copilot

A copilot spawns another copilot, which spawns workers.
When the middle copilot dies, the grandparent is unaffected and
the workers are cleaned up:

```
  Research (copilot)
  └── Planning (copilot)         ← spawned by Research
        ├── Worker A (worker)
        └── Worker B (worker)

  Planning DIES:
    Research    [ALIVE]          ← not a descendant
    Worker A    [DEAD]           ← worker cascade-killed
    Worker B    [DEAD]           ← worker cascade-killed

  tree.lineage("Worker A") → ["Planning", "Research"]
  tree.lineage("Planning") → ["Research"]
```

### 2. Parent signals graceful shutdown before terminating

```
  Parent
    │
    │── handle.signal("drain")    ← child receives AbortSignal
    │   (child finishes current work, drains queue)
    │
    │── handle.terminate()        ← CAS transition to terminated
    │   (registry evicts child)
    │
    │── handle.onEvent:
    │     "signaled"  { signal: "drain" }
    │     "completed" { childId: ... }
    │     "terminated"{ childId: ... }
```

### 3. Multi-level cascade with copilot firewall

```
  Orchestrator (copilot)
  ├── Planner  (copilot) ─────── "firewall" ──────────────────
  │     ├── Researcher (worker)                               │
  │     └── Analyst    (worker)                               │
  ├── Coder    (worker)                                       │
  │     ├── Test1 (worker)                                    │
  │     └── Test2 (worker)                                    │
  └── Reviewer (copilot) ─────── "firewall" ──────────────────
        └── Linter (worker)

  Orchestrator DIES — cascade BFS:
    queue: [Planner, Coder, Reviewer]

    Planner  → copilot → SKIP (don't enqueue Researcher, Analyst)
    Coder    → worker  → EVICT, enqueue [Test1, Test2]
    Reviewer → copilot → SKIP (don't enqueue Linter)
    Test1    → worker  → EVICT
    Test2    → worker  → EVICT

  Result:
    Planner     [ALIVE]   + Researcher [ALIVE] + Analyst [ALIVE]
    Coder       [DEAD]    + Test1 [DEAD] + Test2 [DEAD]
    Reviewer    [ALIVE]   + Linter [ALIVE]
```

---

## Relationship to supervision trees

Lifecycle governance and supervision trees are complementary:

```
                         Agent terminates
                                │
                    ┌───────────┼───────────┐
                    ▼                       ▼
            Is supervised?            Not supervised
            (has parent with          │
             manifest.supervision)    │
                    │                 ▼
                    ▼           CascadingTermination
            SupervisionReconciler     (copilot-aware BFS)
            evaluates restart         │
            policy                    ├─ copilot child? → skip subtree
                    │                 └─ worker child?  → evict + recurse
                    ▼
            Restart or escalate
```

- **Supervision** answers: "should this child be restarted?"
- **Lifecycle governance** answers: "should this child survive its parent's death?"
- **CascadingTermination** is aware of both: it defers to the reconciler for
  supervised children, and skips copilots for lifecycle governance.

---

## Source files

### L0 (`@koi/core`)

| File | Change |
|------|--------|
| `packages/core/src/assembly.ts` | `lifecycle` field on `AgentManifest` |
| `packages/core/src/ecs.ts` | `signal()` + `terminate()` on `ChildHandle`, `ChildLifecycleEvent` kinds |
| `packages/core/src/lifecycle.ts` | `spawner` field on `RegistryEntry` |
| `packages/core/src/agent-state-event.ts` | `spawner` on `AgentRegisteredEvent` + `evolveRegistryEntry` propagation |

### L1 (`@koi/engine`)

| File | Change |
|------|--------|
| `packages/engine/src/types.ts` | Removed `agentType` from `CreateKoiOptions` |
| `packages/engine/src/koi.ts` | `generatePid()` reads `manifest.lifecycle` |
| `packages/engine/src/spawn-child.ts` | AbortController, spawner, idempotency guard |
| `packages/engine/src/child-handle.ts` | `signal()`, `terminate()`, completed/error event mapping |
| `packages/engine/src/cascading-termination.ts` | Copilot-aware BFS, always-await |
| `packages/engine/src/process-tree.ts` | `spawnerMap`, `lineage()` method |

### Tests

| File | Cases |
|------|-------|
| `packages/core/src/agent-state-event.test.ts` | Spawner propagation tests |
| `packages/engine/src/child-handle.test.ts` | Signal, terminate, completed, error events |
| `packages/engine/src/spawn-child.test.ts` | Manifest lifecycle, spawner, AbortController, idempotency |
| `packages/engine/src/cascading-termination.test.ts` | Copilot-aware cascade tests |
| `packages/engine/src/process-tree.test.ts` | Lineage query tests |
| `packages/engine/src/koi.test.ts` | Manifest lifecycle PID generation |
| `packages/engine/src/__tests__/spawn-lifecycle.integration.test.ts` | 11 integration tests |
| `packages/engine/src/__tests__/e2e-lifecycle-governance.test.ts` | 11 E2E tests with real Anthropic LLM |
