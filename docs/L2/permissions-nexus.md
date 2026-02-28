# @koi/permissions-nexus — ReBAC Permission Backend via Nexus

Thin client that delegates all permission decisions, revocation checks, and scope enforcement to the Nexus ReBAC (Relationship-Based Access Control) server. Implements three L0 contracts: `PermissionBackend`, `RevocationRegistry`, and `ScopeEnforcer`.

---

## Why It Exists

The built-in `@koi/middleware-permissions` provides pattern-based permission checks (allow/deny/ask globs) — fast and local, but limited to static rules. When agents need:

- **Delegation chains** — agent A grants agent B read access to `/src`, and B can sub-delegate to C
- **Hierarchical permissions** — granting write on `/src` implies write on `/src/main.ts`
- **Revocation propagation** — revoking a delegation cascades through the chain
- **Cross-node consistency** — permissions checked against a central authority

...pattern matching isn't enough. You need a ReBAC graph.

This package is the **thin client** that talks to Nexus. All permission logic — graph traversal, glob matching, caching, consistency — lives server-side. The client just forwards queries and maps responses. Fail-closed: any error means deny.

---

## Architecture

`@koi/permissions-nexus` is an **L2 feature package** — it depends only on L0 (`@koi/core`) and L0u (`@koi/nexus-client`). Zero external dependencies.

```
┌──────────────────────────────────────────────────────┐
│  @koi/permissions-nexus  (L2)                         │
│                                                        │
│  nexus-permission-backend.ts  ← PermissionBackend      │
│  nexus-revocation-registry.ts ← RevocationRegistry     │
│  nexus-scope-enforcer.ts      ← ScopeEnforcer          │
│  config.ts                    ← config + validation     │
│  types.ts                     ← ReBAC tuples, RPC types │
│  index.ts                     ← public API surface      │
│                                                        │
├──────────────────────────────────────────────────────┤
│  Dependencies                                          │
│                                                        │
│  @koi/core          (L0)   PermissionBackend,          │
│                             RevocationRegistry,         │
│                             ScopeEnforcer,              │
│                             PermissionDecision,         │
│                             PermissionQuery,            │
│                             DelegationId, KoiError      │
│  @koi/nexus-client  (L0u)  NexusClient                 │
└──────────────────────────────────────────────────────┘
```

### How It Fits

```
┌──────────────────────────────────────────────────────────┐
│  Agent Runtime                                            │
│                                                            │
│  ┌──────────────────────────┐                             │
│  │ @koi/middleware-permissions│ ← pattern-based (local)    │
│  │  backend: PatternBackend  │    allow/deny/ask globs     │
│  └──────────────────────────┘                             │
│                OR                                          │
│  ┌──────────────────────────┐     ┌──────────────────┐   │
│  │ @koi/middleware-permissions│ ←──│ @koi/permissions- │   │
│  │  backend: NexusBackend    │    │ nexus (THIS)      │   │
│  └──────────────────────────┘     │                    │   │
│                                    │  thin client       │   │
│                                    │  ● check()         │   │
│                                    │  ● checkBatch()    │   │
│                                    │  ● isRevoked()     │   │
│                                    │  ● revoke()        │   │
│                                    │  ● checkAccess()   │   │
│                                    └────────┬───────────┘   │
│                                              │               │
└──────────────────────────────────────────────┼───────────────┘
                                               │ JSON-RPC 2.0
                                               ▼
                                    ┌──────────────────┐
                                    │  Nexus Server     │
                                    │                    │
                                    │  ● ReBAC graph     │
                                    │  ● glob matching   │
                                    │  ● decision cache  │
                                    │  ● delegation mgmt │
                                    │  ● revocation      │
                                    └──────────────────┘
```

The middleware doesn't care which backend is plugged in — pattern-based and Nexus-backed are interchangeable via the `PermissionBackend` interface.

---

## How It Works

### Thin Client, Fail-Closed

Every permission check is a single RPC call to Nexus. No client-side caching, no local state, no graph traversal. Nexus owns all the logic.

```
check(query)
  │
  ├── rpc("permissions.check", { principal, action, resource })
  │     │
  │     ├── ok + allowed  → { effect: "allow" }
  │     ├── ok + denied   → { effect: "deny", reason }
  │     └── error         → { effect: "deny", reason: "Nexus error: ..." }
  │
  └── Fail-closed: errors always produce deny
```

### Three L0 Contracts

#### 1. PermissionBackend

Answers "can this agent do this action on this resource?"

```
Agent asks: "Can agent:coder write /src/main.ts?"
  │
  ├── client.rpc("permissions.check", {
  │     principal: "agent:coder",
  │     action: "write",
  │     resource: "/src/main.ts"
  │   })
  │
  ├── Nexus traverses ReBAC graph:
  │     agent:coder ──writer──▶ folder:/src
  │     folder:/src  ──parent──▶ file:/src/main.ts
  │     ∴ agent:coder has writer relation on /src/main.ts
  │
  └── Result: { allowed: true }
```

Batch checks send a single `permissions.checkBatch` RPC — Nexus evaluates all queries in one round-trip.

#### 2. RevocationRegistry

Answers "has this delegation been revoked?"

```
isRevoked(delegationId("grant-42"))
  │
  ├── rpc("revocations.check", { id: "grant-42" })
  │     │
  │     ├── { revoked: false } → return false
  │     ├── { revoked: true }  → return true
  │     └── error              → return true (fail-closed)
  │
  └── revoke(id, cascade: true)
       └── rpc("revocations.revoke", { id, cascade: true })
            └── Nexus cascades through delegation chain
```

#### 3. ScopeEnforcer

Adapter from `ScopeAccessRequest` to `PermissionQuery`. Composes with `createEnforcedFileSystem()` from `@koi/scope`.

```
checkAccess({ subsystem: "filesystem", operation: "write", resource: "/src/main.ts" })
  │
  ├── Maps to PermissionQuery:
  │     principal: context.agentId ?? "anonymous"
  │     action: "write"
  │     resource: "/src/main.ts"
  │
  └── Delegates to PermissionBackend.check()
       └── effect === "allow" → true, otherwise → false
```

### ReBAC Relationship Model

Nexus uses Zanzibar-style relationship tuples to model permissions:

```
subject#relation@object

Examples:
  agent:coder#reader@folder:/src
  agent:coder#writer@folder:/src
  agent:admin#deleter@folder:/

Filesystem operations → ReBAC relations:
  ┌───────────┬──────────┐
  │ Operation │ Relation │
  ├───────────┼──────────┤
  │ read      │ reader   │
  │ list      │ reader   │
  │ search    │ reader   │
  │ write     │ writer   │
  │ edit      │ writer   │
  │ rename    │ writer   │
  │ delete    │ deleter  │
  └───────────┴──────────┘
```

---

## API Reference

### Factory Functions

#### `createNexusPermissionBackend(config)`

Creates a Nexus-backed `PermissionBackend`.

| Parameter | Type | Description |
|-----------|------|-------------|
| `config.client` | `NexusClient` | Nexus JSON-RPC client |

**Returns:** `PermissionBackend` with `check()` and `checkBatch()`

#### `createNexusRevocationRegistry(config)`

Creates a Nexus-backed `RevocationRegistry`.

| Parameter | Type | Description |
|-----------|------|-------------|
| `config.client` | `NexusClient` | Nexus JSON-RPC client |

**Returns:** `Required<RevocationRegistry>` — all methods are implemented (`isRevoked`, `isRevokedBatch`, `revoke`)

#### `createNexusScopeEnforcer(config)`

Creates a `ScopeEnforcer` that delegates to a `PermissionBackend`.

| Parameter | Type | Description |
|-----------|------|-------------|
| `config.backend` | `PermissionBackend` | Backend to delegate to |

**Returns:** `ScopeEnforcer` with `checkAccess()` and optional `dispose()`

#### `validateNexusPermissionsConfig(raw)`

Validates raw configuration input.

| Parameter | Type | Description |
|-----------|------|-------------|
| `raw` | `unknown` | Unvalidated config object |

**Returns:** `Result<NexusPermissionsConfig, KoiError>`

### Types

| Type | Description |
|------|-------------|
| `NexusPermissionsConfig` | `{ baseUrl, apiKey, fetch? }` |
| `NexusPermissionBackendConfig` | `{ client: NexusClient }` |
| `NexusRevocationRegistryConfig` | `{ client: NexusClient }` |
| `NexusScopeEnforcerConfig` | `{ backend: PermissionBackend }` |
| `RelationshipTuple` | `{ subject, relation, object }` — Zanzibar-style tuple |
| `NexusCheckResponse` | `{ allowed, reason? }` |
| `NexusCheckBatchResponse` | `{ results: NexusCheckResponse[] }` |
| `NexusRevocationCheckResponse` | `{ revoked }` |
| `NexusRevocationBatchResponse` | `{ results: { id, revoked }[] }` |

### Constants

#### `FS_OPERATION_RELATIONS`

Maps filesystem operation names to ReBAC relation strings.

---

## Examples

### Permission Check

```typescript
import { createNexusClient } from "@koi/nexus-client";
import { createNexusPermissionBackend } from "@koi/permissions-nexus";

const client = createNexusClient({
  baseUrl: "https://nexus.example.com",
  apiKey: process.env.NEXUS_API_KEY!,
});

const backend = createNexusPermissionBackend({ client });

const decision = await backend.check({
  principal: "agent:coder",
  action: "write",
  resource: "/src/main.ts",
});

if (decision.effect === "allow") {
  // proceed with write
} else {
  console.log(`Denied: ${decision.reason}`);
}
```

### Plug into Permissions Middleware

```typescript
import { createPermissionsMiddleware } from "@koi/middleware-permissions";
import { createNexusClient } from "@koi/nexus-client";
import { createNexusPermissionBackend } from "@koi/permissions-nexus";

const client = createNexusClient({
  baseUrl: process.env.NEXUS_URL!,
  apiKey: process.env.NEXUS_API_KEY!,
});

const middleware = createPermissionsMiddleware({
  backend: createNexusPermissionBackend({ client }),
});

// Register in agent assembly — middleware handles tool filtering + HITL
```

### Scope Enforcement for Filesystem

```typescript
import { createNexusClient } from "@koi/nexus-client";
import {
  createNexusPermissionBackend,
  createNexusScopeEnforcer,
} from "@koi/permissions-nexus";

const client = createNexusClient({
  baseUrl: process.env.NEXUS_URL!,
  apiKey: process.env.NEXUS_API_KEY!,
});

const enforcer = createNexusScopeEnforcer({
  backend: createNexusPermissionBackend({ client }),
});

// Compose with enforced filesystem
const allowed = await enforcer.checkAccess({
  subsystem: "filesystem",
  operation: "delete",
  resource: "/tmp/scratch.ts",
  context: { agentId: "agent:cleaner" },
});
// allowed === true or false
```

### Revocation Check

```typescript
import { delegationId } from "@koi/core";
import { createNexusClient } from "@koi/nexus-client";
import { createNexusRevocationRegistry } from "@koi/permissions-nexus";

const client = createNexusClient({
  baseUrl: process.env.NEXUS_URL!,
  apiKey: process.env.NEXUS_API_KEY!,
});

const registry = createNexusRevocationRegistry({ client });

// Check if a delegation has been revoked
const revoked = await registry.isRevoked(delegationId("grant-42"));

// Revoke with cascade (propagates through delegation chain)
await registry.revoke(delegationId("grant-42"), true);
```

### Batch Permission Checks

```typescript
const decisions = await backend.checkBatch?.([
  { principal: "agent:a", action: "read", resource: "/src/main.ts" },
  { principal: "agent:a", action: "write", resource: "/config/prod.json" },
  { principal: "agent:b", action: "delete", resource: "/tmp/scratch.ts" },
]);
// decisions: [{ effect: "allow" }, { effect: "deny", reason: "..." }, ...]
```

---

## Design Decisions

| Decision | Rationale |
|----------|-----------|
| Thin client, no local caching | Nexus handles caching and consistency server-side. Duplicating it client-side adds complexity and staleness risk |
| No client-side glob matching | Nexus evaluates globs in the ReBAC graph context. Client-side globs would create inconsistency between local and server decisions |
| No circuit breaker | The middleware layer (`@koi/middleware-permissions`) already provides circuit breaking. Adding it here would double the resilience logic |
| Fail-closed on all errors | Security-critical: if Nexus is unreachable, deny everything. Never fail-open |
| `Required<RevocationRegistry>` return type | All three methods (`isRevoked`, `isRevokedBatch`, `revoke`) are always implemented — callers never need optional chaining |
| Shared `@koi/nexus-client` transport | Extracted to avoid JSON-RPC duplication across Nexus-backed packages |

---

## Layer Compliance

```
L0  @koi/core ──────────────────────────────────────┐
    PermissionBackend, RevocationRegistry,            │
    ScopeEnforcer, PermissionDecision,                │
    PermissionQuery, DelegationId, KoiError           │
                                                       │
L0u @koi/nexus-client ──────────────────────────┐    │
    NexusClient                                  │    │
                                                  ▼    ▼
L2  @koi/permissions-nexus ◄──────────────────────┴────┘
    imports from L0 + L0u only
    ✗ never imports @koi/engine (L1)
    ✗ never imports peer L2 packages
    ✗ zero external dependencies
```

---

## Related

- [middleware-permissions](middleware-permissions.md) — local pattern-based permission middleware (uses `PermissionBackend` interface)
- [nexus-client](nexus-client.md) — shared JSON-RPC 2.0 transport for Nexus
- [@koi/core permissions contract](../../packages/core/src/permissions/) — L0 interfaces (`PermissionBackend`, `RevocationRegistry`, `ScopeEnforcer`)
