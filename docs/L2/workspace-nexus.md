# @koi/workspace-nexus — Nexus-Backed Workspace State Sync

Cross-device workspace awareness for Koi agents. Stores workspace metadata in a Raft-replicated Nexus server while keeping files local — enabling federated swarm patterns where agents on different machines know about each other's workspaces.

---

## Why It Exists

The git worktree backend (`@koi/workspace`) provides fast local isolation but is **single-device only**. When agents run across multiple machines — CI runners, developer laptops, cloud VMs — they have no awareness of each other's workspaces:

```
Machine A                          Machine B
┌─────────────┐                   ┌─────────────┐
│ Agent 1     │                   │ Agent 3     │
│  workspace/ │   ← invisible →  │  workspace/ │
│ Agent 2     │                   │ Agent 4     │
│  workspace/ │                   │  workspace/ │
└─────────────┘                   └─────────────┘
```

With `@koi/workspace-nexus`, workspace metadata is persisted to Nexus:

```
Machine A                 Nexus (Raft)              Machine B
┌─────────────┐     ┌──────────────────┐     ┌─────────────┐
│ Agent 1     │────▶│ ws-agent1: {     │◀────│ Agent 3     │
│ Agent 2     │────▶│   host: "A",     │◀────│ Agent 4     │
└─────────────┘     │   path: "/tmp/…" │     └─────────────┘
                    │ }                │
                    │ ws-agent2: {…}   │
                    │ ws-agent3: {…}   │
                    │ ws-agent4: {…}   │
                    └──────────────────┘
```

This enables:

| Capability | Without Nexus backend | With Nexus backend |
|---|---|---|
| Local workspace isolation | Yes (git/docker) | Yes (local temp dirs) |
| Cross-device workspace awareness | No | Yes |
| Federated swarm coordination | No | Yes (shared state via Raft) |
| Persistent workspace metadata | No (in-memory only) | Yes (survives restarts) |
| Workspace health probes across devices | No | Yes (Nexus artifact check) |

---

## Architecture

```
L0  @koi/core              WorkspaceBackend, WorkspaceInfo, WorkspaceId
L0u @koi/nexus-client      JSON-RPC 2.0 transport
L2  @koi/workspace-nexus   Nexus-backed WorkspaceBackend (this package)
L2  @koi/workspace          Provider + git/docker backends (peer, no import)
```

### Internal module map

```
src/
├── index.ts                    ← public re-exports
├── types.ts                    ← NexusWorkspaceBackendConfig, WorkspaceArtifact
├── constants.ts                ← DEFAULT_BASE_PATH, DEFAULT_TIMEOUT_MS, etc.
├── nexus-workspace-client.ts   ← thin RPC wrapper (save/load/remove)
└── nexus-backend.ts            ← createNexusWorkspaceBackend() factory
```

### Ordering invariant

Both `create()` and `dispose()` follow **Nexus-first** ordering:

```
create():   Nexus save  ──►  local mkdir   (rollback Nexus on mkdir failure)
dispose():  Nexus remove ──►  local rmdir  (local failure is non-fatal)
```

This ensures Nexus is always the source of truth. If a crash occurs between steps, Nexus state is consistent and local dirs are ephemeral.

---

## How It Works

### Create flow

```
backend.create(agentId, config)
  │
  ├─ Validate agentId (non-empty)
  ├─ Generate WorkspaceId: "nexus-ws-{agentId}-{timestamp}-{uuid8}"
  ├─ Build WorkspaceArtifact with hostname, config, status="active"
  │
  ├─ [Nexus] Save artifact via RPC "write"
  │    └─ On failure → return error (no local dir created)
  │
  ├─ [Local] mkdir -p baseDir/{workspaceId}
  │    └─ On failure → rollback: delete Nexus artifact, return error
  │
  ├─ [Local] Write .koi-workspace marker file
  │    └─ On failure → warn only (non-fatal)
  │
  └─ Return WorkspaceInfo { id, path, createdAt, metadata }
```

### Dispose flow

```
backend.dispose(workspaceId)
  │
  ├─ [Nexus] Remove artifact via RPC "remove"
  │    └─ NOT_FOUND treated as success (idempotent)
  │    └─ Other failure → return error (local dir preserved for retry)
  │
  ├─ [Local] rm -rf baseDir/{workspaceId}
  │    └─ On failure → warn only (Nexus artifact already gone)
  │
  └─ Return ok
```

### Health check (local-first short-circuit)

```
backend.isHealthy(workspaceId)
  │
  ├─ [Local] Check dir + marker file exist (sync, no network)
  │    └─ Missing → return false immediately
  │
  ├─ [Nexus] Load artifact via RPC "read"
  │    └─ Unreachable → return false (fail-closed)
  │    └─ NOT_FOUND → return false
  │
  └─ Return true
```

### Timeout protection

All Nexus RPC calls are wrapped with `Promise.race` against a configurable timeout (default: 10s). Timers are cleaned up on the happy path to prevent event loop leaks.

---

## API

### `createNexusWorkspaceBackend(config)`

Factory function. Validates config at creation time, returns `Result<WorkspaceBackend, KoiError>`.

```typescript
import { createNexusWorkspaceBackend } from "@koi/workspace-nexus";

const result = createNexusWorkspaceBackend({
  nexusUrl: "http://nexus.internal:2026",
  apiKey: process.env.NEXUS_API_KEY ?? "",
  baseDir: ".koi/workspaces",   // optional, default: ".koi/workspaces"
  basePath: "/workspaces",       // optional, Nexus RPC path prefix
  timeoutMs: 10_000,             // optional, default: 10_000
  fetch: customFetch,            // optional, for testing
});

if (!result.ok) throw new Error(result.error.message);
const backend = result.value;
```

### `NexusWorkspaceBackendConfig`

```typescript
interface NexusWorkspaceBackendConfig {
  readonly nexusUrl: string;           // Required. Nexus server URL
  readonly apiKey: string;             // Required. Bearer auth token
  readonly basePath?: string;          // Nexus artifact path prefix. Default: "/workspaces"
  readonly baseDir?: string;           // Local workspace dir. Default: ".koi/workspaces"
  readonly timeoutMs?: number;         // Nexus RPC timeout. Default: 10_000
  readonly fetch?: typeof fetch;       // Injectable fetch for testing
}
```

### `WorkspaceArtifact`

The shape stored in Nexus per workspace:

```typescript
interface WorkspaceArtifact {
  readonly id: WorkspaceId;
  readonly agentId: string;
  readonly hostId: string;             // os.hostname()
  readonly localPath: string;
  readonly createdAt: number;
  readonly config: ResolvedWorkspaceConfig;
  readonly status: "active" | "disposing" | "disposed";
}
```

---

## Examples

### 1. Swap git backend for Nexus (one-line change)

```typescript
import { createWorkspaceProvider } from "@koi/workspace";
-import { createGitWorktreeBackend } from "@koi/workspace";
+import { createNexusWorkspaceBackend } from "@koi/workspace-nexus";

-const backend = createGitWorktreeBackend({ repoPath: "." });
+const backend = createNexusWorkspaceBackend({
+  nexusUrl: "http://nexus:2026",
+  apiKey: process.env.NEXUS_API_KEY ?? "",
+});
if (!backend.ok) throw new Error(backend.error.message);

// Everything else stays the same
const provider = createWorkspaceProvider({
  backend: backend.value,
  cleanupPolicy: "on_success",
});
```

### 2. Full agent setup with Nexus workspace

```typescript
import { createKoi } from "@koi/engine";
import { createWorkspaceProvider } from "@koi/workspace";
import { createNexusWorkspaceBackend } from "@koi/workspace-nexus";
import { WORKSPACE } from "@koi/core";

const backend = createNexusWorkspaceBackend({
  nexusUrl: process.env.NEXUS_URL ?? "http://localhost:2026",
  apiKey: process.env.NEXUS_API_KEY ?? "",
});
if (!backend.ok) throw new Error(backend.error.message);

const provider = createWorkspaceProvider({ backend: backend.value });
if (!provider.ok) throw new Error(provider.error.message);

const runtime = await createKoi({
  manifest: { name: "my-agent", version: "1.0.0", model: { name: "claude-haiku-4-5-20251001" } },
  providers: [provider.value],
  engine: myEngineAdapter,
});

// Access workspace path
const ws = runtime.agent.component(WORKSPACE);
console.log(ws?.path);  // "/abs/path/.koi/workspaces/nexus-ws-my-agent-1709..."
```

### 3. Testing with mock fetch

```typescript
const mockFetch = async () => new Response(
  JSON.stringify({ jsonrpc: "2.0", id: 1, result: null }),
  { status: 200 },
);

const backend = createNexusWorkspaceBackend({
  nexusUrl: "http://localhost:2026",
  apiKey: "test-key",
  fetch: mockFetch,
});
```

---

## Error handling

| Scenario | Behavior | Result |
|---|---|---|
| Nexus unreachable during `create()` | No local dir created | `Result.error` (retryable) |
| Nexus OK, local mkdir fails | Nexus artifact rolled back | `Result.error` |
| Nexus unreachable during `dispose()` | Local dir preserved for retry | `Result.error` (retryable) |
| Nexus OK, local rmdir fails | Log warning, return success | `Result.ok` |
| Double `dispose()` | Nexus NOT_FOUND treated as success | `Result.ok` (idempotent) |
| `isHealthy()` with Nexus down | Fail-closed | `false` |
| Empty `nexusUrl` or `apiKey` | Factory rejects | `Result.error` (VALIDATION) |
| Empty `agentId` | `create()` rejects | `Result.error` (VALIDATION) |

---

## Layer compliance

```
L0  @koi/core ─────────────────────────────────┐
    WorkspaceBackend, WorkspaceId, Result        │
                                                 │
L0u @koi/nexus-client ─────────────────────┐    │
    NexusClient, createNexusClient          │    │
                                            ▼    ▼
L2  @koi/workspace-nexus ◄─────────────────┘────┘
    imports from L0 + L0u only
    ✗ never imports @koi/engine (L1)
    ✗ never imports @koi/workspace or peer L2
    ✗ zero external runtime dependencies
```

---

## Related

- [Issue #394](https://github.com/windoliver/koi/issues/394) — Original feature request
- `docs/workspace.md` — Workspace isolation overview (git + docker backends)
- `docs/L2/nexus-client.md` — Nexus JSON-RPC transport layer
