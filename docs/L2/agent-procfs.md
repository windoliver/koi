# @koi/agent-procfs — Agent Introspection Virtual Filesystem

An L2 package that provides a Linux-inspired `/proc`-style virtual filesystem for inspecting running agent state. Mount read-only (or writable) entries under `/agents/<id>/` and query them at any time — no polling, no framework coupling, no runtime overhead when not read.

---

## Why It Exists

Koi agents are opaque at runtime. The `AgentRegistry` tracks lifecycle state (phase, generation), but there's no way to answer:

- What tools does agent X have attached?
- What middleware is active on agent Y?
- What are agent Z's environment variables?
- What children has agent W spawned?
- What's agent X's current priority?

`@koi/agent-procfs` fixes this by exposing a virtual filesystem that lazily reads agent internals on demand:

```
/agents/worker-1/status       → { phase: "running", generation: 3 }
/agents/worker-1/tools        → ["search", "code-edit", "file-read"]
/agents/worker-1/middleware   → ["audit", "rate-limit", "governance"]
/agents/worker-1/children     → ["sub-worker-1", "sub-worker-2"]
/agents/worker-1/config       → { name: "worker-1", description: "..." }
/agents/worker-1/env          → { API_KEY: "sk-...", MODEL: "claude-opus-4-6" }
/agents/worker-1/metrics      → { priority: 5, ... }
```

---

## Architecture

### Layer position

```
L0  @koi/core              ─ ProcFs, ProcEntry, WritableProcEntry (contracts)
L2  @koi/agent-procfs      ─ this package (no L1 dependency)
```

`@koi/agent-procfs` imports only from `@koi/core` (L0). It never touches `@koi/engine` (L1) or any peer L2 package.

### Internal module map

```
index.ts                       ← public re-exports
│
├── procfs-impl.ts             ← ProcFs implementation with TTL cache
├── agent-mounter.ts           ← watches registry, mounts/unmounts per agent
└── entries/
    ├── status.ts              ← /agents/<id>/status
    ├── tools.ts               ← /agents/<id>/tools
    ├── middleware.ts           ← /agents/<id>/middleware
    ├── children.ts            ← /agents/<id>/children
    ├── config.ts              ← /agents/<id>/config
    ├── env.ts                 ← /agents/<id>/env
    └── metrics.ts             ← /agents/<id>/metrics (writable: priority)
```

---

## Data Flow

### Mount on register

When an agent registers, the mounter watches the registry and automatically mounts 7 entries:

```
AgentRegistry                AgentMounter                   ProcFs
     │                            │                           │
     │  event: "registered"       │                           │
     │  { entry: { agentId } }    │                           │
     │ ──────────────────────────>│                           │
     │                            │                           │
     │                            │  mount("/agents/<id>/status", ...)
     │                            │  mount("/agents/<id>/tools", ...)
     │                            │  mount("/agents/<id>/middleware", ...)
     │                            │  mount("/agents/<id>/children", ...)
     │                            │  mount("/agents/<id>/config", ...)
     │                            │  mount("/agents/<id>/env", ...)
     │                            │  mount("/agents/<id>/metrics", ...)
     │                            │ ────────────────────────>│
```

### Read (lazy evaluation)

```
caller                         ProcFs                    ProcEntry
  │                              │                          │
  │  read("/agents/a1/tools")   │                          │
  │ ───────────────────────────>│                          │
  │                              │                          │
  │                      ┌───────┴───────┐                  │
  │                      │ TTL cache hit?│                  │
  │                      └───────┬───────┘                  │
  │                              │ miss                     │
  │                              │  entry.read()            │
  │                              │ ────────────────────────>│
  │                              │                          │
  │                              │  ← ["search", "edit"]   │
  │                              │  cache result            │
  │                              │                          │
  │  ["search", "edit"]          │                          │
  │ <───────────────────────────│                          │
```

### Unmount on deregister

```
AgentRegistry                AgentMounter                   ProcFs
     │                            │                           │
     │  event: "deregistered"     │                           │
     │  { agentId }               │                           │
     │ ──────────────────────────>│                           │
     │                            │  unmount("/agents/<id>/status")
     │                            │  unmount("/agents/<id>/tools")
     │                            │  ... (all 7 entries)
     │                            │ ────────────────────────>│
```

---

## TTL Microcache

Each entry has a per-path TTL cache (default: 1 second) to avoid redundant reads:

```
Time 0.0s: read("/agents/a1/status")  → calls entry.read() → caches result
Time 0.3s: read("/agents/a1/status")  → returns cached value (within TTL)
Time 0.8s: read("/agents/a1/status")  → returns cached value (within TTL)
Time 1.1s: read("/agents/a1/status")  → calls entry.read() → refreshes cache
```

Cache is invalidated on:
- TTL expiry (configurable via `cacheTtlMs`)
- `write()` to the same path
- `mount()` replacing an existing entry

---

## Entries

### `/agents/<id>/status`

Read-only. Returns the agent's process identity and state.

```typescript
{ pid: ProcessId, state: AgentState, terminationOutcome?: TerminationOutcome }
```

### `/agents/<id>/tools`

Read-only. Returns attached tool descriptors (name, description, schema).

### `/agents/<id>/middleware`

Read-only. Returns attached middleware names and hook counts.

### `/agents/<id>/children`

Read-only. Returns child agent IDs from the registry (filters by `parentId`).

### `/agents/<id>/config`

Read-only. Returns the agent's manifest configuration.

### `/agents/<id>/env`

Read-only. Returns the agent's `AgentEnv` values (if the ENV component is attached).

### `/agents/<id>/metrics`

**Writable**. Returns `{ priority, ...metrics }`. Writing to this entry updates the agent's priority via `registry.patch()`.

---

## API Reference

### `createProcFs(config?)`

Creates a ProcFs instance with optional TTL cache configuration.

```typescript
import { createProcFs } from "@koi/agent-procfs";

const procFs = createProcFs({ cacheTtlMs: 2000 }); // 2s cache
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `cacheTtlMs` | `number` | `1000` | TTL for cached reads (0 = no cache) |

### `createAgentMounter(config)`

Creates a mounter that watches a registry and auto-mounts/unmounts ProcFs entries per agent.

```typescript
import { createAgentMounter, createProcFs } from "@koi/agent-procfs";

const procFs = createProcFs();
const mounter = createAgentMounter({
  registry,
  procFs,
  agentProvider: (id) => agentMap.get(id),
});

// Later: cleanup
mounter.dispose();
```

| Config field | Type | Description |
|-------------|------|-------------|
| `registry` | `AgentRegistry` | Registry to watch for events |
| `procFs` | `ProcFs` | ProcFs instance to mount entries on |
| `agentProvider` | `(id: AgentId) => Agent \| undefined` | Resolves agent ID to Agent instance |

### ProcFs methods

| Method | Signature | Notes |
|--------|-----------|-------|
| `mount` | `(path: string, entry: ProcEntry \| WritableProcEntry) => void` | Mount entry at path |
| `unmount` | `(path: string) => void` | Remove entry |
| `read` | `(path: string) => Promise<unknown>` | Read entry value (cached) |
| `write` | `(path: string, value: unknown) => Promise<void>` | Write to writable entry |
| `list` | `(path: string) => Promise<readonly string[]>` | List child path segments |
| `entries` | `() => readonly string[]` | All mounted paths |

---

## Examples

### 1. Inspect a running agent

```typescript
import { createProcFs, createAgentMounter } from "@koi/agent-procfs";

const procFs = createProcFs();
const mounter = createAgentMounter({ registry, procFs, agentProvider });

// After agents register, inspect them:
const status = await procFs.read("/agents/worker-1/status");
// → { pid: { id: "worker-1", name: "worker-1", ... }, state: "running" }

const tools = await procFs.read("/agents/worker-1/tools");
// → [{ name: "search", description: "Web search", ... }]

const children = await procFs.read("/agents/worker-1/children");
// → ["sub-worker-1", "sub-worker-2"]
```

### 2. List all agents

```typescript
const agentIds = await procFs.list("/agents");
// → ["worker-1", "worker-2", "copilot-1"]
```

### 3. Update agent priority at runtime

```typescript
// Write to the metrics entry to update priority
await procFs.write("/agents/worker-1/metrics", { priority: 1 });

// Verify via read
const metrics = await procFs.read("/agents/worker-1/metrics");
// → { priority: 1 }
```

---

## Testing

### Unit tests

Colocated with source:

```
src/procfs-impl.test.ts       ← 13 tests: mount/unmount, caching, write, list
src/agent-mounter.test.ts      ← 7 tests: mount/unmount lifecycle, churn simulation
```

Key test scenarios:
- Mount and read entries
- TTL cache returns cached value within TTL
- Write invalidates cache
- Mount replaces existing entry and invalidates cache
- Churn simulation: register/deregister 10 agents while reading — no crashes
- Dispose stops watching registry events
- Skips mount when agent provider returns undefined

---

## Layer Compliance

```
L0  @koi/core ─────────────────────────────────────────────┐
    ProcFs, ProcEntry, WritableProcEntry, AgentRegistry     │
    Agent, SubsystemToken, ENV                              │
                                                            │
                                                            ▼
L2  @koi/agent-procfs ◄────────────────────────────────────┘
    imports from L0 only
    ✗ never imports @koi/engine (L1)
    ✗ never imports peer L2 packages
```
