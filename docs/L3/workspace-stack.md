# @koi/workspace-stack — Nexus Workspace Backend Factory

Layer 3 backend factory that creates raw Nexus-backed workspace pieces (filesystem backend, scope enforcer, semantic search retriever) from a single config object. Callers like `@koi/governance` compose these into providers and middleware.

**Layer:** L3 (depends on L0, L0u, and L2 packages)

---

## What This Enables

**One-call Nexus workspace setup.** Instead of manually creating a NexusClient, configuring a filesystem backend, wiring permission checks, and setting up semantic search, callers get all three raw pieces from one factory:

```typescript
const { backend, enforcer, retriever } = createWorkspaceStack({
  nexusBaseUrl: "https://nexus.example.com",
  nexusApiKey: "sk-...",
  agentId: agentId("agent_42"),
});
```

These pieces plug directly into `@koi/governance`:

```typescript
const governance = createGovernanceStack({
  preset: "standard",
  backends: { filesystem: backend },
  enforcer,
  // retriever can be passed to createFileSystemProvider for semantic search
});
```

### What agents get

| Capability | How | Source |
|-----------|-----|--------|
| Remote file read/write/edit/list/search/delete/rename | `backend` → Nexus JSON-RPC | `@koi/filesystem-nexus` |
| Per-file permission checks | `enforcer` → Nexus ReBAC tuples | `@koi/permissions-nexus` |
| Semantic search over indexed files | `retriever` → Nexus search API | `@koi/search-nexus` |

---

## Architecture

`@koi/workspace-stack` is a **backend factory**, not a composition layer. It creates raw pieces — governance owns the composition chain (enforcement → scope → provider).

```
  createWorkspaceStack(config)
  │
  ├── 1. Create shared NexusClient
  │       └── baseUrl + apiKey + optional fetch
  │
  ├── 2. Create raw FileSystemBackend
  │       └── createNexusFileSystem({ client, basePath: scopeRoot })
  │
  ├── 3. Create ScopeEnforcer (if permissions enabled)
  │       └── createNexusScopeEnforcer({ backend: createNexusPermissionBackend({ client }) })
  │
  └── 4. Create Retriever (if search enabled)
          └── createNexusSearch({ baseUrl, apiKey }).retriever

  Returns: { backend, enforcer?, retriever? }
           ─────────────────────────────────
           Raw pieces — caller composes them
```

### Why factory, not composition?

`@koi/governance` already owns the enforcement → scope → provider chain:

```
  workspace-stack (creates)         governance (composes)
  ┌───────────────────────┐        ┌─────────────────────────────────┐
  │ backend (raw)         │───────→│ createEnforcedFileSystem()      │
  │ enforcer              │───────→│ createFileSystemProvider()      │
  │ retriever             │───────→│ (passed to provider for search) │
  └───────────────────────┘        └─────────────────────────────────┘
```

If workspace-stack also composed, governance would duplicate or conflict with the wrapping.

---

## Configuration

```typescript
interface WorkspaceStackConfig {
  readonly nexusBaseUrl: string;         // Nexus server URL
  readonly nexusApiKey: string;          // Bearer token
  readonly agentId: AgentId;             // Agent identity
  readonly scope?: {
    readonly root?: string;              // Default: /agents/{agentId}/workspace
  };
  readonly search?: {
    readonly enabled?: boolean;          // Default: true
    readonly minScore?: number;          // Minimum relevance threshold
  };
  readonly permissions?: {
    readonly enabled?: boolean;          // Default: true
  };
  readonly fetch?: typeof globalThis.fetch;  // Injectable for testing
}
```

| Config | Default | Description |
|--------|---------|-------------|
| `nexusBaseUrl` | (required) | Nexus JSON-RPC endpoint |
| `nexusApiKey` | (required) | API key for authentication |
| `agentId` | (required) | Agent identity for scoping and permissions |
| `scope.root` | `/agents/{agentId}/workspace` | Filesystem base path on Nexus |
| `search.enabled` | `true` | Create semantic search retriever |
| `search.minScore` | — | Minimum relevance score for search results |
| `permissions.enabled` | `true` | Create scope enforcer for ReBAC checks |
| `fetch` | `globalThis.fetch` | Override for testing with fake fetch |

---

## Return Type

```typescript
interface WorkspaceStackBundle {
  readonly backend: FileSystemBackend;      // Raw — NOT enforced
  readonly enforcer?: ScopeEnforcer;        // Pass to governance
  readonly retriever?: Retriever;           // Pass to FileSystemProvider
}
```

| Field | Present when | Pass to |
|-------|-------------|---------|
| `backend` | Always | `governance.backends.filesystem` |
| `enforcer` | `permissions.enabled !== false` | `governance.enforcer` |
| `retriever` | `search.enabled !== false` | `createFileSystemProvider({ retriever })` |

---

## Examples

### Minimal — Defaults

```typescript
import { createWorkspaceStack } from "@koi/workspace-stack";
import { agentId } from "@koi/core";

const { backend, enforcer, retriever } = createWorkspaceStack({
  nexusBaseUrl: "https://nexus.example.com",
  nexusApiKey: process.env.NEXUS_API_KEY!,
  agentId: agentId("agent_42"),
});
// backend at /agents/agent_42/workspace, enforcer + retriever enabled
```

### With Governance

```typescript
import { createWorkspaceStack } from "@koi/workspace-stack";
import { createGovernanceStack } from "@koi/governance";
import { createKoi } from "@koi/engine";

const workspace = createWorkspaceStack({
  nexusBaseUrl: "https://nexus.example.com",
  nexusApiKey: "sk-...",
  agentId: agentId("agent_42"),
});

const governance = createGovernanceStack({
  preset: "standard",
  backends: { filesystem: workspace.backend },
  enforcer: workspace.enforcer,
});

const runtime = await createKoi({
  manifest,
  adapter,
  middleware: governance.middlewares,
  providers: governance.providers,
});
```

### Custom Scope Root

```typescript
const { backend } = createWorkspaceStack({
  nexusBaseUrl: "https://nexus.example.com",
  nexusApiKey: "sk-...",
  agentId: agentId("agent_42"),
  scope: { root: "/projects/my-project/workspace" },
  permissions: { enabled: false },
  search: { enabled: false },
});
```

### Testing with Fake Nexus

```typescript
import { createFakeNexusFetch } from "@koi/test-utils";

const { backend } = createWorkspaceStack({
  nexusBaseUrl: "http://fake-nexus",
  nexusApiKey: "test-key",
  agentId: agentId("test_agent"),
  permissions: { enabled: false },
  search: { enabled: false },
  fetch: createFakeNexusFetch(),
});

await backend.write("/hello.txt", "hello");
const result = await backend.read("/hello.txt");
// → { ok: true, value: { content: "hello" } }
```

---

## API Reference

### Factory

| Function | Returns | Description |
|----------|---------|-------------|
| `createWorkspaceStack(config)` | `WorkspaceStackBundle` | Creates raw Nexus workspace pieces |

### Types

| Type | Description |
|------|-------------|
| `WorkspaceStackConfig` | `{ nexusBaseUrl, nexusApiKey, agentId, scope?, search?, permissions?, fetch? }` |
| `WorkspaceStackBundle` | `{ backend, enforcer?, retriever? }` |

---

## Design Decisions

| Decision | Rationale |
|----------|-----------|
| Factory, not composition | Governance owns the enforcement → scope → provider chain. Avoids duplication. |
| Returns raw pieces | Callers compose as needed. Maximum flexibility. |
| Shared NexusClient | One client for all Nexus calls (filesystem, permissions, search). |
| Default scope root `/agents/{id}/workspace` | Convention over configuration. Each agent gets its own namespace. |
| Permissions default: enabled | Secure by default. Opt out explicitly. |
| Search default: enabled | Semantic search is free with Nexus. Opt out if not needed. |
| Config validation throws | Required fields are system boundary — fail fast on misconfiguration. |

---

## Composition with Nexus Ecosystem

All Nexus packages talk to the same server but implement different L0 contracts:

```
  createWorkspaceStack(config)
  │
  ├── @koi/nexus-client         shared NexusClient (JSON-RPC transport)
  │       │
  │       ├── @koi/filesystem-nexus   → FileSystemBackend  (file CRUD)
  │       ├── @koi/permissions-nexus  → ScopeEnforcer      (ReBAC checks)
  │       └── @koi/search-nexus       → Retriever           (semantic search)
  │
  └── Returns { backend, enforcer?, retriever? }
```

---

## Layer Compliance

```
L0  @koi/core ──────────────────────────────────────────────┐
    AgentId, FileSystemBackend, ScopeEnforcer, Result         │
                                                               │
L0u @koi/nexus-client ────────────────────────────────────  │
    createNexusClient()                                        │
                                                               │
L0u @koi/search-provider ─────────────────────────────────  │
    Retriever type                                             │
                                                               │
L2  @koi/filesystem-nexus ─────────────────────────────────  │
    createNexusFileSystem()                                    │
                                                               │
L2  @koi/permissions-nexus ────────────────────────────────  │
    createNexusPermissionBackend(), createNexusScopeEnforcer() │
                                                               │
L2  @koi/search-nexus ─────────────────────────────────────  │
    createNexusSearch()                                        │
                                                               ▼
L3  @koi/workspace-stack ◄─────────────────────────────────  ┘
    imports from L0 + L0u + L2
    ✗ no new logic — only wiring
    ✗ never imports @koi/engine (L1)
    ✓ All interface properties readonly
    ✓ Config validated at boundary
```

---

## Related

- Issue: #673 — feat: Nexus-backed filesystem + workspace stack
- `@koi/filesystem-nexus` — L2 backend this factory creates
- `@koi/filesystem` — Wraps backend as agent tools (fs_read, fs_write, etc.)
- `@koi/governance` — L3 that composes the raw pieces into providers
- `@koi/store-nexus` — Same Nexus pattern for ForgeStore (brick storage)
