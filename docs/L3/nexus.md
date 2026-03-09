# @koi/nexus — One-Line Nexus Backend Wiring

Convenience package that composes all 13+ Nexus L2 backend packages into a single `createNexusStack()` call — single config in, fully wired backends out, auto-scoped per agent during assembly.

---

## Why It Exists

Koi's Nexus integration is spread across 13+ independent L2 packages, each requiring its own factory call with repeated `baseUrl`/`apiKey` boilerplate:

| Package | Layer | Scope | Purpose |
|---------|-------|-------|---------|
| `@koi/registry-nexus` | L2 | Global | Agent lifecycle CAS registry |
| `@koi/permissions-nexus` | L2 | Global | ReBAC permission checks |
| `@koi/audit-nexus` | L2 | Global | Buffered audit event sink |
| `@koi/search-nexus` | L2 | Global | Full-text search backend |
| `@koi/scheduler-nexus` | L2 | Global | Task + schedule + queue stores |
| `@koi/pay-nexus` | L2 | Global | Token usage ledger |
| `@koi/name-service-nexus` | L2 | Global | Human-readable agent names |
| `@koi/nexus-store` | L2 | Agent | Forge, events, session, memory, snapshots |
| `@koi/filesystem-nexus` | L2 | Agent | Virtual filesystem |
| `@koi/ipc-nexus` | L2 | Agent | Mailbox (agent-to-agent messaging) |
| `@koi/scratchpad-nexus` | L2 | Group | Shared scratchpad per agent group |
| `@koi/workspace-nexus` | L2 | Opt-in | Workspace backend |

Without this package:

- **13+ factory calls** with repeated `baseUrl`/`apiKey` on every one
- **Manual namespace provisioning** — you must `mkdir` each agent's path prefix before creating backends
- **Manual agent scoping** — you must implement a `ComponentProvider` that creates per-agent backends in `attach()` and cleans up in `detach()`
- **Manual scratchpad wiring** — group-scoped agents need special detection of `pid.groupId` and middleware collection
- **No disposal tracking** — mailboxes and scratchpad middleware leak if not explicitly cleaned up

This L3 bundle provides:

- **One-call setup** — `createNexusStack()` creates and connects all backends
- **Auto-scoping** — agent-scoped backends are created lazily per agent via `ComponentProvider.attach()`
- **Auto-provisioning** — namespace directories are created automatically via `ensureNamespace()`
- **Disposal tracking** — mailboxes and per-agent resources are cleaned up on `detach()`
- **Selective opt-out** — any backend can be disabled with `false` or customized with override config

---

## What This Enables

```
BEFORE: Manual wiring (13+ imports, repeated config, manual scoping)
═══════════════════════════════════════════════════════════════════

import { createNexusRegistry } from "@koi/registry-nexus";
import { createNexusPermissionBackend } from "@koi/permissions-nexus";
import { createNexusAuditSink } from "@koi/audit-nexus";
import { createNexusSearch } from "@koi/search-nexus";
import { createNexusSchedulerBackends } from "@koi/scheduler-nexus";
import { createNexusPayLedger } from "@koi/pay-nexus";
import { createNexusNameService } from "@koi/name-service-nexus";
import { createNexusForgeStore } from "@koi/nexus-store";
import { createNexusEventBackend } from "@koi/nexus-store";
import { createNexusSessionStore } from "@koi/nexus-store";
import { createNexusMemoryBackend } from "@koi/nexus-store";
import { createNexusSnapshotStore } from "@koi/nexus-store";
import { createNexusFileSystem } from "@koi/filesystem-nexus";
import { createNexusMailbox } from "@koi/ipc-nexus";

const baseUrl = "http://localhost:2026";
const apiKey = process.env.NEXUS_API_KEY!;

const registry = await createNexusRegistry({ baseUrl, apiKey });
const permissions = createNexusPermissionBackend({ baseUrl, apiKey });
const audit = createNexusAuditSink({ baseUrl, apiKey });
const search = createNexusSearch({ baseUrl, apiKey, fetchFn: fetch });
const scheduler = createNexusSchedulerBackends({ baseUrl, apiKey });
const pay = createNexusPayLedger({ baseUrl, apiKey });
const nameService = await createNexusNameService({ baseUrl, apiKey });

// ... then manually build a ComponentProvider for per-agent backends
// ... then manually handle namespace provisioning
// ... then manually track disposables for cleanup


AFTER: Nexus stack (1 import, 1 function call)
═══════════════════════════════════════════════

import { createNexusStack } from "@koi/nexus";

const nexus = await createNexusStack({
  baseUrl: "http://localhost:2026",
  apiKey: process.env.NEXUS_API_KEY!,
});

const runtime = await createKoi({
  manifest,
  adapter,
  registry: nexus.backends.registry,
  providers: [...nexus.providers],
  middleware: [...nexus.middlewares],
});
```

---

## Architecture

`@koi/nexus` is an **L3 meta-package** — it composes L2 packages with minimal orchestration logic.

### Three-Tier Backend Model

```
┌─ Global (created eagerly at startup via Promise.all) ─────────────┐
│ registry · permissions · audit · search · scheduler · pay · names  │
│ Shared singletons. No agentId needed.                              │
└────────────────────────────────────────────────────────────────────┘

┌─ Agent-scoped (created lazily in ComponentProvider.attach()) ─────┐
│ forge · events · session · memory · snapshots · filesystem · mail  │
│ Paths auto-derived from agent.pid.id.                              │
└────────────────────────────────────────────────────────────────────┘

┌─ Group-scoped (created lazily, requires agent.pid.groupId) ───────┐
│ scratchpad                                                         │
│ Skipped if agent has no groupId.                                   │
└────────────────────────────────────────────────────────────────────┘

┌─ Opt-in (disabled by default) ────────────────────────────────────┐
│ workspace                                                          │
│ Enabled via optIn: { workspace: { basePath: "/ws" } }              │
└────────────────────────────────────────────────────────────────────┘
```

### Package Structure

```
┌──────────────────────────────────────────────────────────────────┐
│  @koi/nexus  (L3)                                                │
│                                                                  │
│  types.ts              ← config, bundle, override interfaces     │
│  validate-config.ts    ← boundary validation via validation()    │
│  namespace.ts          ← path computation + auto-provisioning    │
│  global-backends.ts    ← eagerly-created globals (Promise.all)   │
│  agent-provider.ts     ← ComponentProvider (attach/detach)       │
│  nexus-stack.ts        ← createNexusStack() factory              │
│  index.ts              ← public API surface                      │
│                                                                  │
├──────────────────────────────────────────────────────────────────┤
│  Dependencies (13+ L2 packages)                                  │
│                                                                  │
│  @koi/registry-nexus     @koi/permissions-nexus                  │
│  @koi/audit-nexus        @koi/search-nexus                       │
│  @koi/scheduler-nexus    @koi/pay-nexus                          │
│  @koi/name-service-nexus @koi/nexus-store                        │
│  @koi/filesystem-nexus   @koi/ipc-nexus                          │
│  @koi/scratchpad-nexus   @koi/workspace-nexus                    │
│  @koi/nexus-client       @koi/core                               │
└──────────────────────────────────────────────────────────────────┘
```

---

## Quick Start

```typescript
import { createNexusStack } from "@koi/nexus";

// Embed mode — no URL, auto-starts local Nexus daemon
const nexus = await createNexusStack({});

// Remote mode — connect to existing Nexus server
const nexus = await createNexusStack({
  baseUrl: "https://nexus.mycompany.com",
  apiKey: process.env.NEXUS_API_KEY,
});

// Wire into Koi runtime
const runtime = await createKoi({
  manifest,
  adapter,
  registry: nexus.backends.registry,
  providers: [...nexus.providers],
  middleware: [...nexus.middlewares],
});

// Cleanup on shutdown
await nexus.dispose();
```

### Embed Mode (Local Auto-Start)

When `baseUrl` is omitted, `createNexusStack()` lazy-imports `@koi/nexus-embed` and auto-starts a local Nexus daemon. No manual `nexus serve` required — see [docs/L2/nexus-embed.md](../L2/nexus-embed.md) for details.

---

## Selective Opt-Out

Disable any backend by setting it to `false`:

```typescript
const nexus = await createNexusStack({
  baseUrl: "http://localhost:2026",
  apiKey: process.env.NEXUS_API_KEY!,
  overrides: {
    // Disable backends you don't need
    permissions: false,
    audit: false,
    search: false,
  },
});

// nexus.backends.permissions === undefined
// nexus.backends.audit === undefined
// nexus.backends.search === undefined
// nexus.backends.registry — still active
```

## Override Config

Pass config objects to customize individual backends:

```typescript
const nexus = await createNexusStack({
  baseUrl: "http://localhost:2026",
  apiKey: process.env.NEXUS_API_KEY!,
  overrides: {
    scheduler: { timeoutMs: 5_000, visibilityTimeoutMs: 60_000 },
    audit: { batchSize: 200, flushIntervalMs: 10_000 },
  },
});
```

## Opt-In Backends

Workspace is disabled by default. Enable it via `optIn`:

```typescript
const nexus = await createNexusStack({
  baseUrl: "http://localhost:2026",
  apiKey: process.env.NEXUS_API_KEY!,
  optIn: {
    workspace: { basePath: "/workspaces" },
  },
});
```

---

## How Agent Scoping Works

When `createKoi` assembles an agent, it calls `provider.attach(agent)` on each `ComponentProvider`. The nexus agent provider:

```
attach(agent)
    │
    ├─ 1. Extract agent.pid.id and agent.pid.groupId
    │
    ├─ 2. Compute namespace paths (frozen per #922)
    │     agents/{agentId}/bricks
    │     agents/{agentId}/events
    │     agents/{agentId}/session
    │     agents/{agentId}/memory/entities
    │     agents/{agentId}/snapshots
    │     agents/{agentId}/workspace
    │     agents/{agentId}/mailbox
    │     groups/{groupId}/scratch  (if groupId)
    │
    ├─ 3. Best-effort auto-provisioning (mkdir via Nexus RPC)
    │
    ├─ 4. Create agent-scoped backends
    │     forge, events, session, memory, snapshots,
    │     filesystem, mailbox, [workspace], [scratchpad]
    │
    ├─ 5. Track disposables in disposal map
    │
    └─ 6. Return { components, skipped }


detach(agent)
    │
    ├─ 1. Dispose mailbox (Symbol.dispose)
    │
    └─ 2. Remove from disposal map
```

Child agents spawned with the same providers automatically get their own scoped backends — `attach()` uses `childAgent.pid.id` to derive unique paths.

---

## Bundle Return Type

```typescript
interface NexusBundle {
  readonly backends: NexusGlobalBackends;          // registry, permissions, audit, etc.
  readonly providers: readonly ComponentProvider[]; // Agent-scoped provider
  readonly middlewares: readonly KoiMiddleware[];   // Scratchpad flush, etc.
  readonly client: NexusClient;                    // For advanced usage
  readonly config: ResolvedNexusMeta;              // Inspection metadata
  readonly dispose: () => Promise<void>;           // Cleanup all resources
}

interface NexusGlobalBackends {
  readonly registry?: AgentRegistry | undefined;
  readonly permissions?: ScopeChecker | undefined;
  readonly audit?: AuditSink | undefined;
  readonly search?: SearchBackend | undefined;
  readonly scheduler?: SchedulerBackends | undefined;
  readonly pay?: PayLedger | undefined;
  readonly nameService?: NameService | undefined;
}
```

---

## Key Types

| Type | Purpose |
|------|---------|
| `NexusStackConfig` | Top-level user-facing config: baseUrl, apiKey, overrides, optIn |
| `NexusBundle` | Return type — backends, providers, middlewares, client, config, dispose |
| `NexusGlobalBackends` | All global-scope backends (each `T \| undefined`) |
| `NexusConnectionConfig` | Shared connection: baseUrl, apiKey, optional fetch |
| `GlobalBackendOverrides` | Per-global-backend: `false` to disable, config object to customize |
| `AgentBackendOverrides` | Per-agent-backend: config objects for forge, events, mailbox |
| `OptInOverrides` | Opt-in backends: workspace |
| `ResolvedNexusMeta` | Inspection: baseUrl, globalBackendCount, flags |

---

## Manifest Integration

The `@koi/manifest` schema supports an optional `nexus` section:

```yaml
# agent.yaml
name: my-agent
version: 1.0.0
model:
  name: claude-sonnet-4-5-20250514

nexus:
  url: ${NEXUS_URL}
```

```typescript
import { loadManifest } from "@koi/manifest";
import { createNexusStack } from "@koi/nexus";

const manifest = await loadManifest("agent.yaml");
const nexus = await createNexusStack({
  baseUrl: manifest.nexus?.url ?? process.env.NEXUS_URL!,
  apiKey: process.env.NEXUS_API_KEY!,
});
```

---

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Global backends eagerly created | `Promise.all()` for async backends | Registry and nameService need startup warmup; fail-fast on connection issues |
| Agent backends lazily created | Via `ComponentProvider.attach()` | No agent context available at startup; each agent needs unique namespace paths |
| Shared credentials | Single `baseUrl`/`apiKey` + path-scoped namespaces | Agents are isolated by namespace path, not by credentials |
| Auto-provisioning best-effort | `Promise.allSettled()`, failures logged | Directories may already exist; provisioning failure shouldn't block agent start |
| Disposal map with warning | Warning at 10k entries | Detects leaked agents (attach without detach) in long-running processes |
| Scratchpad requires groupId | Skipped if `agent.pid.groupId` is undefined | Solo agents don't need group-scoped shared state |
| Workspace opt-in | Disabled by default | Not all deployments need workspace; avoids unnecessary resource allocation |
| Shared fetch function | Passed through `conn.fetch` | Platform connection pooling; avoids creating per-backend HTTP clients |

---

## Testing

42 unit tests across 6 test files, 96%+ coverage:

| Test file | Tests | Covers |
|-----------|-------|--------|
| `validate-config.test.ts` | 7 | Required fields, empty strings, valid configs |
| `namespace.test.ts` | 6 | Path computation, parallel mkdir, failure resilience |
| `global-backends.test.ts` | 9 | All globals created, opt-out via false, override merge |
| `agent-provider.test.ts` | 8 | attach/detach, groupId, scratchpad, workspace, idempotent cleanup |
| `nexus-stack.test.ts` | 10 | Full flow, dispose, config metadata, validation errors |
| `api-surface.test.ts` | 2 | Export snapshot stability |

---

## Layer Compliance

- [x] `@koi/nexus` only imports from L0 (`@koi/core`) and L2 nexus packages
- [x] No imports from `@koi/engine` (L1)
- [x] No cross-L2 imports between non-nexus packages
- [x] All interface properties are `readonly`
- [x] Listed in `L3_PACKAGES` in `scripts/layers.ts`
- [x] Layer check passes: `bun run scripts/check-layers.ts`
