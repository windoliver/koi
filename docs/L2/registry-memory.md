# @koi/registry-memory — In-Memory Agent Registry

An L2 implementation of the `AgentRegistry` contract (L0) backed by an EventBackend. Events are the source of truth; the current state of every agent is a derived projection rebuilt by folding events through a pure function. Swap any `EventBackend` — in-memory for tests, SQLite for single-node, Nexus for multi-node — without changing a line of registry code.

---

## Why It Exists

The default `InMemoryRegistry` (L1) stores mutable state in a `Map`. State transitions are applied, notifications emitted, but the transitions themselves are discarded. This means:

- No audit trail — you cannot answer "what happened to agent X at 3am?"
- No replay — you cannot reconstruct state from history after a crash
- No time-travel debugging — you cannot inspect intermediate states

`@koi/registry-memory` fixes all three by making events the source of truth:

```
                InMemoryRegistry              MemoryRegistry
                ────────────────              ────────────────────
State store:    Map<AgentId, Entry>           EventBackend (append-only log)
Current state:  IS the store                  DERIVED from fold(events)
Audit trail:    None                          Every event persisted forever
Replay:         Impossible                    rebuild() re-folds all events
Concurrency:    Last-write-wins               CAS via expectedSequence
```

---

## Architecture

### Layer position

```
L0  @koi/core               ─ AgentRegistry, AgentStateEvent, evolveRegistryEntry
L2  @koi/registry-memory  ─ this package (no L1 dependency)
```

`@koi/registry-memory` imports only from `@koi/core` (L0). It never touches `@koi/engine` (L1) or any peer L2 package. This means it can be used in any context — tests, CLI tools, standalone services — without pulling in the full runtime.

### Internal module map

```
index.ts                       ← public re-exports
│
├── memory-registry.ts  ← factory + AgentRegistry implementation
├── stream-ids.ts              ← per-agent stream ID helpers
└── __tests__/
    └── e2e.test.ts            ← full-stack E2E with real LLM
```

### Event stream topology

Each agent gets its own append-only event stream. A shared index stream tracks which agents exist for startup rebuild.

```
EventBackend
├── "agent-registry-index"           ← lightweight index (agentId only)
│   ├── { type: "index:registered",   data: { agentId: "agent-1" } }
│   ├── { type: "index:registered",   data: { agentId: "agent-2" } }
│   └── { type: "index:deregistered", data: { agentId: "agent-1" } }
│
├── "agent:agent-1"                  ← full lifecycle events
│   ├── { kind: "agent_registered",   agentType: "worker", ... }
│   ├── { kind: "agent_transitioned", from: "created", to: "running", gen: 1 }
│   └── { kind: "agent_deregistered", deregisteredAt: 1708900000 }
│
└── "agent:agent-2"
    ├── { kind: "agent_registered",   agentType: "copilot", ... }
    └── { kind: "agent_transitioned", from: "created", to: "running", gen: 1 }
```

---

## Data Flow

### Register

```
caller                  MemoryRegistry              EventBackend
  │                            │                              │
  │  register(entry)           │                              │
  │ ──────────────────────────>│                              │
  │                            │  append("agent:<id>",        │
  │                            │    { kind: "agent_registered" │
  │                            │      expectedSequence: 0 })  │
  │                            │ ────────────────────────────>│
  │                            │                              │
  │                            │  append("agent-registry-index", │
  │                            │    { type: "index:registered" }) │
  │                            │ ────────────────────────────>│
  │                            │                              │
  │                            │  update projection Map       │
  │                            │  notify watchers             │
  │                            │                              │
  │  RegistryEntry             │                              │
  │ <──────────────────────────│                              │
```

### Transition (with CAS)

```
caller                  MemoryRegistry              EventBackend
  │                            │                              │
  │  transition(id, "running", │                              │
  │    gen=0, reason)          │                              │
  │ ──────────────────────────>│                              │
  │                            │                              │
  │                    ┌───────┴───────┐                      │
  │                    │ CAS check:    │                      │
  │                    │ gen == current?│                      │
  │                    │ edge valid?   │                      │
  │                    └───────┬───────┘                      │
  │                            │                              │
  │                            │  append("agent:<id>",        │
  │                            │    { kind: "agent_transitioned" │
  │                            │      expectedSequence: N })  │
  │                            │ ────────────────────────────>│
  │                            │                              │
  │                            │  update projection           │
  │                            │  notify watchers             │
  │                            │                              │
  │  Result<RegistryEntry>     │                              │
  │ <──────────────────────────│                              │
```

### Rebuild (startup or recovery)

```
MemoryRegistry                          EventBackend
       │                                          │
       │  read("agent-registry-index")            │
       │ ────────────────────────────────────────>│
       │                                          │
       │  ← [index:registered "a-1",              │
       │     index:registered "a-2",              │
       │     index:deregistered "a-1"]            │
       │                                          │
       │  discovered IDs: { "a-2" }               │
       │                                          │
       │  read("agent:a-2")                       │
       │ ────────────────────────────────────────>│
       │                                          │
       │  ← [agent_registered, agent_transitioned]│
       │                                          │
       │  fold events → RegistryEntry             │
       │  projection.set("a-2", entry)            │
```

---

## Concurrency Model

Every mutation uses **optimistic concurrency control** via `expectedSequence`:

```
Agent "a-1" at generation 0, stream sequence 2

  Thread A: transition("a-1", "running", gen=0)
  Thread B: transition("a-1", "running", gen=0)    ← concurrent

  EventBackend:
    Thread A: append(expectedSequence: 2) → OK (seq now 3)
    Thread B: append(expectedSequence: 2) → CONFLICT (seq is 3)

  Result:
    Thread A: { ok: true,  value: entry }
    Thread B: { ok: false, error: { code: "CONFLICT" } }
```

Two layers of CAS work together:

| Layer | Mechanism | Catches |
|-------|-----------|---------|
| Registry | `expectedGeneration` in transition args | Stale generation (application-level) |
| Backend | `expectedSequence` in append | Stream-level concurrent writes |

If either check fails, the transition returns a `CONFLICT` error — no data is corrupted.

---

## AgentStateEvent (L0 types)

Three event kinds form a discriminated union on the `kind` field:

| Event | Kind | Key fields |
|-------|------|------------|
| Registered | `"agent_registered"` | `agentId`, `agentType`, `parentId?`, `metadata`, `registeredAt` |
| Transitioned | `"agent_transitioned"` | `agentId`, `from`, `to`, `generation`, `reason`, `conditions`, `transitionedAt` |
| Deregistered | `"agent_deregistered"` | `agentId`, `deregisteredAt` |

The pure fold function `evolveRegistryEntry(state, event)` derives `RegistryEntry` from events:

```
evolveRegistryEntry(undefined, registered)   → RegistryEntry { phase: "created", gen: 0 }
evolveRegistryEntry(entry,     transitioned) → RegistryEntry { phase: "running", gen: 1 }
evolveRegistryEntry(entry,     deregistered) → undefined (removed from projection)
```

The fold is **deterministic** — the same event sequence always produces the same state.

---

## API Reference

### Factory

#### `createMemoryRegistry(backend)`

Creates an in-memory `AgentRegistry` backed by an `EventBackend`.

Returns a `Promise<MemoryRegistry>` because startup requires folding existing events to rebuild the projection cache.

```typescript
import { createMemoryRegistry } from "@koi/registry-memory";
import { createInMemoryEventBackend } from "@koi/events-memory";

const backend = createInMemoryEventBackend();
const registry = await createMemoryRegistry(backend);
```

### MemoryRegistry interface

Extends `AgentRegistry` with sync-narrowed read methods and a `rebuild()` method.

| Method | Signature | Notes |
|--------|-----------|-------|
| `register` | `(entry: RegistryEntry) => Promise<RegistryEntry>` | Appends `agent_registered` event |
| `deregister` | `(id: AgentId) => Promise<boolean>` | Appends `agent_deregistered` event |
| `lookup` | `(id: AgentId) => RegistryEntry \| undefined` | **Sync** — reads projection |
| `list` | `(filter?: RegistryFilter) => readonly RegistryEntry[]` | **Sync** — filters projection |
| `transition` | `(id, targetPhase, expectedGen, reason) => Promise<Result<RegistryEntry, KoiError>>` | CAS-protected |
| `watch` | `(listener: (event: RegistryEvent) => void) => () => void` | Returns unsubscribe function |
| `rebuild` | `() => Promise<void>` | Re-fold all events from backend |
| `[Symbol.asyncDispose]` | `() => Promise<void>` | Clears projection and listeners |

### Stream ID helpers

| Function | Signature | Example |
|----------|-----------|---------|
| `agentStreamId` | `(id: AgentId) => string` | `"agent:my-agent-1"` |
| `parseAgentStreamId` | `(streamId: string) => AgentId \| undefined` | `"agent:foo" → agentId("foo")` |
| `REGISTRY_INDEX_STREAM` | `string` (constant) | `"agent-registry-index"` |

---

## Examples

### 1. Basic lifecycle

```typescript
import { agentId } from "@koi/core";
import { createInMemoryEventBackend } from "@koi/events-memory";
import { createMemoryRegistry } from "@koi/registry-memory";

const backend = createInMemoryEventBackend();
const registry = await createMemoryRegistry(backend);

// Register
const entry = await registry.register({
  agentId: agentId("worker-1"),
  agentType: "worker",
  metadata: { name: "File processor" },
  registeredAt: Date.now(),
  status: { phase: "created", generation: 0, conditions: [], lastTransitionAt: 0 },
});

// Transition with CAS
const result = await registry.transition(
  agentId("worker-1"),
  "running",
  0,                           // expectedGeneration
  { kind: "assembly_complete" },
);
if (result.ok) {
  console.log(result.value.status.phase); // "running"
  console.log(result.value.status.generation); // 1
}

// Lookup (sync)
const current = registry.lookup(agentId("worker-1"));

// Deregister
await registry.deregister(agentId("worker-1"));
```

### 2. Watch for lifecycle events

```typescript
const events: RegistryEvent[] = [];
const unsubscribe = registry.watch((event) => {
  events.push(event);
});

await registry.register({ ... });
// events[0] → { kind: "registered", entry: ... }

await registry.transition(agentId("worker-1"), "running", 0, { kind: "assembly_complete" });
// events[1] → { kind: "transitioned", from: "created", to: "running", ... }

unsubscribe();
```

### 3. Rebuild after crash

```typescript
// Simulate crash: create a new registry instance from the same backend
const recovered = await createMemoryRegistry(backend);

// All state is restored by folding events
const entry = recovered.lookup(agentId("worker-1"));
// entry.status.phase === "running" (rebuilt from event log)
```

### 4. Multi-agent with filtering

```typescript
await registry.register({ agentId: agentId("a"), agentType: "worker", ... });
await registry.register({ agentId: agentId("b"), agentType: "copilot", ... });
await registry.register({ agentId: agentId("c"), agentType: "worker", ... });

await registry.transition(agentId("a"), "running", 0, { kind: "assembly_complete" });

// List all running workers (sync)
const running = registry.list({ phase: "running", agentType: "worker" });
// → [entry for "a"]
```

### 5. Audit trail from event backend

```typescript
import { agentStreamId } from "@koi/registry-memory";

// Read the raw event log for any agent
const streamId = agentStreamId(agentId("worker-1"));
const result = await backend.read(streamId);

if (result.ok) {
  for (const envelope of result.value.events) {
    console.log(envelope.sequence, envelope.type, envelope.data);
    // 1 "agent_registered"   { kind: "agent_registered", ... }
    // 2 "agent_transitioned" { kind: "agent_transitioned", from: "created", to: "running", ... }
    // 3 "agent_transitioned" { kind: "agent_transitioned", from: "running", to: "terminated", ... }
  }
}
```

---

## Backend Pluggability

The registry is parameterized by `EventBackend` (L0 interface). Swap the backend to change storage without touching registry code:

```
┌──────────────────────────────────────────────────────────┐
│         createMemoryRegistry(backend)               │
│                                                          │
│  EventBackend                                            │
│  ┌───────────────────────────────────────────────────┐   │
│  │  .append(streamId, event)  → Result<{sequence}>   │   │
│  │  .read(streamId)           → Result<{events[]}>   │   │
│  └───────────────────────────────────────────────────┘   │
└──────────────────────────────┬───────────────────────────┘
                               │
            ┌──────────────────┼──────────────────┐
            ▼                  ▼                  ▼
  ┌──────────────────┐ ┌──────────────┐ ┌──────────────────┐
  │ @koi/events-memory│ │ events-sqlite│ │  events-nexus    │
  │ In-memory (tests) │ │ bun:sqlite   │ │  Multi-node      │
  │ ✅ Available      │ │ ✅ Available  │ │  (via Nexus AI)  │
  │                   │ │ (Single-node)│ │  🔜 #397         │
  └──────────────────┘ └──────────────┘ └──────────────────┘
```

Available backends:
- **`@koi/events-memory`** — in-memory, suitable for tests and ephemeral use
- **`@koi/events-sqlite`** (#396) — single-node durable persistence via `bun:sqlite`

Planned:
- **#397** — `@koi/events-nexus` (multi-node, shared Nexus filesystem)

---

## State Machine Reference

The valid agent lifecycle transitions (from `VALID_TRANSITIONS` in L0):

```
                    ┌──────────────┐
                    │   created    │
                    └──────┬───────┘
                           │ assembly_complete
                           ▼
              ┌──────── running ────────┐
              │            │            │
    awaiting_ │            │ completed/ │ error/
    response  │            │ user_stop  │ timeout
              ▼            │            ▼
          waiting          │       terminated
              │            │
    response_ │            │
    received  │            │
              └──► running ┘
                      │
              suspend │
                      ▼
                 suspended
                      │
              resume  │
                      ▼
                   running
```

Each transition is CAS-protected by `generation` — stale writes are rejected with a `CONFLICT` error.

---

## Testing

### Contract tests

Reusable contract tests live in `@koi/test-utils`:

```typescript
import { runMemoryRegistryContractTests } from "@koi/test-utils";
import { createInMemoryEventBackend } from "@koi/events-memory";
import { createMemoryRegistry } from "@koi/registry-memory";

runMemoryRegistryContractTests(async () => {
  const backend = createInMemoryEventBackend();
  const registry = await createMemoryRegistry(backend);
  return { registry, backend };
});
```

Contract tests cover:
- Basic CRUD (register, lookup, list, deregister)
- CAS transitions and generation tracking
- Watch notifications
- Rebuild produces identical state
- N=10 concurrent transitions — exactly one succeeds per generation
- Golden fixture schema stability

### E2E tests

Full-stack E2E tests run through `createKoi` + `createPiAdapter` with real Anthropic API calls, verifying the memory registry works correctly within the complete L1 runtime.

---

## Layer Compliance

```
L0  @koi/core ─────────────────────────────────────────────┐
    AgentRegistry, AgentStateEvent, evolveRegistryEntry     │
    VALID_TRANSITIONS, error factories                      │
                                                            │
                                                            ▼
L2  @koi/registry-memory ◄───────────────────────────┘
    imports from L0 only
    ✗ never imports @koi/engine (L1)
    ✗ never imports peer L2 packages
```

**Dev-only dependencies** (`@koi/engine`, `@koi/engine-pi`, `@koi/events-memory`, `@koi/test-utils`) are used in tests but are not runtime imports — the package remains a clean L2 citizen.
