# Registry-Scoped Agent Visibility

Permission-filtered agent discovery so agents only see agents they are
authorized to see. Enables multi-tenant isolation and least-privilege
discovery without changing the core `AgentRegistry` interface.

**Layer**: L1 (`@koi/engine`)
**Issue**: #663

---

## Why It Exists

Without visibility filtering, `registry.list()` returns every registered
agent. Any agent can discover any other agent regardless of ownership,
tenant boundaries, or permission policies. This is a problem for:

- **Multi-tenant deployments** — tenant-A agents can discover tenant-B agents
- **Least privilege** — agents see capabilities they should not know about
- **Security boundaries** — discovery is the first step toward unauthorized messaging

```
                Before                              After
                ------                              -----
registry.list(): all 50 agents returned             only 3 agents caller can see
Cross-tenant:    agent-A sees agent-B (tenant-2)    filtered out by permission check
Audit:           no visibility boundary              "discover" action logged per query
```

---

## Architecture

### Composable decorator pattern

The visibility filter wraps any `AgentRegistry` implementation without
modifying it. All non-`list` methods delegate directly to the inner registry.

```
  caller
    |
    v
  createVisibilityFilter(inner, permissions, config)
    |
    ├── list(filter, visibility?)
    |     1. inner.list(filter)          → candidate entries
    |     2. permissions.checkBatch()    → allow/deny per entry
    |     3. return only "allow" entries
    |
    ├── register  → inner.register   (pass-through)
    ├── deregister → inner.deregister (pass-through)
    ├── lookup    → inner.lookup     (pass-through)
    ├── transition → inner.transition (pass-through)
    └── watch     → inner.watch      (pass-through)
```

### Layer placement

- **L0** (`@koi/core`): `VisibilityContext` type, updated `AgentRegistry.list()` signature
- **L1** (`@koi/engine`): `createVisibilityFilter` decorator
- **L2** (`@koi/ipc-nexus`): `ipc_discover` tool passes caller identity automatically
- **L2** (`@koi/permissions-nexus`): `PermissionBackend` implementation (pre-existing)

No new packages were created. No layer boundaries were crossed.

---

## API

### `VisibilityContext` (L0)

```typescript
interface VisibilityContext {
  readonly callerId: AgentId;
  readonly callerZoneId?: ZoneId | undefined;
}
```

Passed as the second argument to `registry.list()`. When provided, the
visibility filter checks each candidate entry against the permission backend.

### `createVisibilityFilter` (L1)

```typescript
function createVisibilityFilter(
  inner: AgentRegistry,
  permissions: PermissionBackend,
  config?: VisibilityFilterConfig,
): AgentRegistry
```

| Config field | Type | Default | Description |
|---|---|---|---|
| `strictVisibility` | `boolean` | `false` | When `true`, return `[]` if no `VisibilityContext` is provided. When `false` (default), return all entries for backward compatibility. |

### Permission query shape

For each candidate entry, a `PermissionQuery` is built:

```typescript
{
  principal: visibility.callerId,     // "agent-alice"
  action:    "discover",              // fixed action
  resource:  `agent:${entry.agentId}` // "agent:agent-bob"
  context:   { callerZoneId: "..." }  // only if callerZoneId is set
}
```

The filter uses `checkBatch()` when available on the backend, falling back
to `Promise.all` of individual `check()` calls.

---

## Behavior

| Scenario | Result |
|---|---|
| `visibility` provided, permission allows | Entry included |
| `visibility` provided, permission denies | Entry filtered out |
| `visibility` provided, permission returns `"ask"` | Entry filtered out (treated as deny) |
| `visibility` provided, permission backend throws | Empty array (fail-closed) |
| No `visibility`, `strictVisibility: false` | All entries returned (migration default) |
| No `visibility`, `strictVisibility: true` | Empty array |
| Empty registry | Empty array (no permission checks made) |

---

## Usage

### Basic setup

```typescript
import { createInMemoryRegistry, createVisibilityFilter } from "@koi/engine";
import { createNexusPermissionBackend } from "@koi/permissions-nexus";

const rawRegistry = createInMemoryRegistry();
const permissions = createNexusPermissionBackend({ client: nexusClient });

const registry = createVisibilityFilter(rawRegistry, permissions);
```

### How ipc_discover uses it

The `ipc_discover` tool (in `@koi/ipc-nexus`) automatically threads the
caller's `agentId` as a `VisibilityContext`:

```typescript
// Inside createDiscoverTool — happens automatically
const visibility = callerId !== undefined ? { callerId } : undefined;
const entries = await registry.list(filter, visibility);
```

The `mailbox-provider` wires the agent identity:

```typescript
customTools: (_backend, agent) => {
  const tool = createDiscoverTool(registry, prefix, trustTier, agent.pid.id);
  // ...
};
```

No manual wiring needed in agent code — discovery is visibility-scoped
when the registry is wrapped with the decorator.

---

## Performance

| Concern | Decision | Rationale |
|---|---|---|
| Stateless decorator | No caching | Simple, no stale-cache bugs, permissions can change at any time |
| `checkBatch` preferred | Single round-trip | Nexus backend already implements `checkBatch` |
| `Promise.all` fallback | N concurrent checks | Acceptable for small registries; production should use `checkBatch` |
| Filter before permissions | Data filter narrows first | Reduces permission check count |

---

## Migration

The default behavior is **fail-open**: when no `VisibilityContext` is
provided, all entries are returned. This means existing code that calls
`registry.list()` without visibility context continues to work unchanged.

Migration path to fail-closed:

1. Wrap registry with `createVisibilityFilter(registry, backend)`
2. Ensure all callers pass `VisibilityContext` (currently only `ipc_discover` does)
3. Set `strictVisibility: true` to enforce — calls without context return `[]`

---

## Follow-up work

- **Startup wiring**: Apply the decorator in the app entrypoint or `@koi/starter`
- **`discover_agents` scope**: Permission filtering for external agent discovery
- **Contract test suite**: Shared `runVisibilityFilterContractTests` in `@koi/test-utils`
- **Nexus ReBAC tuples**: Model `agent:X#visible@agent:Y` relationships in Nexus
