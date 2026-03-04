# @koi/name-service-nexus — Nexus-Backed Name Service

Implements the L0 `NameServiceBackend` contract using Nexus as the authoritative store for name records. Agents on different nodes can resolve human-readable names to `AgentId` or `BrickId` across the cluster. Maintains a local in-memory projection for fast reads, synchronized via periodic polling. Write operations hit Nexus first, then update the local projection immediately (write-then-project pattern).

---

## Why It Exists

In a single-node Koi deployment, `@koi/name-service` provides in-memory name resolution with TTL-based expiry. Agent name bindings are per-node — Node 2 cannot resolve a name registered on Node 1.

Without this package, you'd need to:
1. Build a custom distributed name store with conflict detection
2. Map the L0 `NameServiceBackend` contract to your backend's wire format
3. Keep a local cache synchronized via polling for fast reads
4. Diff remote state against local state to emit correct change events
5. Handle write-then-project semantics so local state is instantly consistent
6. Do all of the above while respecting Koi's layer architecture (L2 → L0 only)

`@koi/name-service-nexus` handles all of this. Point it at a Nexus server and names registered on any node are resolvable from every other node.

---

## What This Enables

### Before vs After

```
BEFORE: names registered on one node are invisible to others
═════════════════════════════════════════════════════════════

  Node 1                    Node 2                    Node 3
  ┌──────────────┐          ┌──────────────┐          ┌──────────────┐
  │  registers    │          │  registers    │          │              │
  │  "reviewer"   │   ???    │  "coder"      │   ???    │  resolve     │
  │              │───────X  │              │───────X  │  "reviewer"? │
  │              │          │              │          │  NOT_FOUND!  │
  └──────────────┘          └──────────────┘          └──────────────┘

  No cross-node resolution. Names are invisible across nodes.


AFTER: Nexus provides a shared name store visible to all nodes
══════════════════════════════════════════════════════════════

                      ┌─────────────────────────────┐
                      │     Nexus Server (Hub)       │
                      │                              │
                      │  reviewer  → agent:a-7f3c    │
                      │  coder    → agent:b-2d1a    │
                      │  my-tool  → brick:t-9e5f    │
                      └──────┬──────────┬────────┬───┘
                  poll/sync  │          │        │  poll/sync
               ┌─────────────┘          │        └─────────────┐
               ▼                        ▼                      ▼
  ┌──────────────────┐    ┌──────────────────┐    ┌──────────────────┐
  │  Node 1          │    │  Node 2          │    │  Node 3          │
  │  resolve("coder")│    │  resolve("reviewer")│ │  resolve("reviewer")│
  │  → agent:b-2d1a  │    │  → agent:a-7f3c  │    │  → agent:a-7f3c  │
  └──────────────────┘    └──────────────────┘    └──────────────────┘
```

### Cross-Node Name Resolution

```
Agent C (Node 3) wants to find the "reviewer" agent:

┌─────────┐                    ┌───────────────┐
│ Agent C │                    │  Nexus Name   │
│ Node 3  │                    │  Service      │
└────┬────┘                    └──────┬────────┘
     │                                │
     │  resolve("reviewer")           │
     │───────────────────────────────▶│
     │                                │  (reads from local
     │                                │   projection — fast)
     │◀───────────────────────────────│
     │  { ok: true, value: {          │
     │    record: { binding:          │
     │      { kind: "agent",          │
     │        agentId: "a-7f3c" }     │
     │    },                          │
     │    matchedAlias: false          │
     │  }}                            │
     │                                │
```

---

## Architecture

### Data Flow

```
                        ┌─────────────────────┐
                        │    Nexus Server      │
                        │   (source of truth)  │
                        └─────────┬────────────┘
                                  │
                    ┌─────────────┼─────────────┐
                    │             │             │
                 register      poll          renew
                 deregister    (periodic)
                    │             │             │
                    ▼             ▼             ▼
           ┌──────────────────────────────────────────┐
           │         createNexusNameService()          │
           │                                           │
           │  ┌─────────────┐  ┌──────────────────┐   │
           │  │  projection  │  │  records Map      │   │
           │  │  (local)     │  │  aliases Map      │   │
           │  └──────┬───────┘  └──────────────────┘   │
           │         │                                  │
           │         ▼                                  │
           │  ┌─────────────┐                          │
           │  │  listeners   │  onChange() subscribers  │
           │  │  Set<fn>     │  receive events from     │
           │  └─────────────┘  local ops + poll diffs   │
           └───────────────────────────────────────────┘
                    │
                    ▼
           Fast reads: resolve(), search(), suggest()
           return from projection — no network call
```

### Write-Then-Project Pattern

Writes go to Nexus first. On success, the local projection is updated immediately — callers see their own writes without waiting for the next poll cycle.

```
register("code-reviewer", ...)
  │
  ├─ 1. Validate locally (name format, alias count, capacity)
  │     └─ Fail fast — no RPC on validation error
  │
  ├─ 2. RPC to Nexus: name.register
  │     └─ Nexus returns NexusNameRecord on success
  │
  ├─ 3. Map wire record to domain NameRecord
  │
  ├─ 4. Update local projection immediately
  │
  └─ 5. Notify listeners: { kind: "registered", ... }
```

### Poll-Based Sync

```
Every pollIntervalMs (default: 5s):

  poll()
    │
    ├─ nexusAnsList(zoneId) → get all name records
    │
    ├─ applyList() diffs against local projection:
    │   ├─ New records → emit "registered"
    │   ├─ Removed records → emit "unregistered"
    │   └─ Changed expiresAt → emit "renewed"
    │
    └─ Silent skip on poll failure (stale projection > crash)
```

### Layer Compliance

```
  L0  @koi/core ──────────────────────────────────────────────┐
      NameServiceBackend, NameRecord, NameBinding, AnsConfig,  │
      NameRegistration, Result, KoiError, ForgeScope           │
                                                               │
  L0u @koi/name-resolution ───────────────────────────────────┤
      compositeKey(), validateName(), resolveByScope(),         │
      computeSuggestions()                                      │
                                                               │
  L0u @koi/validation ────────────────────────────────────────┤
      levenshteinDistance() — reused via name-resolution        │
                                                               │
  L2  @koi/name-service-nexus ◄───────────────────────────────┘
      imports from L0 + L0u only
      ✗ never imports @koi/engine (L1)
      ✗ never imports @koi/name-service (peer L2)
      ✗ never imports @koi/nexus-client (ships own RPC)
```

---

## API Reference

### Factory Function

| Function | Returns | Purpose |
|----------|---------|---------|
| `createNexusNameService(config)` | `Promise<NameServiceBackend>` | Create a Nexus-backed name service with eager warmup |
| `validateNexusNameServiceConfig(config)` | `Result<NexusNameServiceConfig, KoiError>` | Validate config at system boundary |

### Configuration

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `baseUrl` | `string` | — | Nexus server URL (required) |
| `apiKey` | `string` | — | API key for authentication (required) |
| `zoneId` | `string?` | `undefined` | Zone scope for name listing |
| `timeoutMs` | `number` | `10_000` | RPC call timeout in milliseconds |
| `pollIntervalMs` | `number` | `5_000` | Poll interval. 0 = disabled |
| `maxEntries` | `number` | `10_000` | Max names in local projection |
| `fetch` | `typeof fetch?` | `globalThis.fetch` | Injectable fetch for testing |
| `ansConfig` | `Partial<AnsConfig>?` | `DEFAULT_ANS_CONFIG` | ANS config overrides |

### NameServiceBackend Methods

All methods from the L0 contract:

| Method | Signature | Description |
|--------|-----------|-------------|
| `register` | `(registration) → Promise<Result<NameRecord, KoiError>>` | Register name in Nexus + local projection |
| `unregister` | `(name, scope) → Promise<boolean>` | Delete from Nexus + remove from projection |
| `renew` | `(name, scope, ttlMs?) → Promise<Result<NameRecord, KoiError>>` | TTL renewal via Nexus |
| `resolve` | `(name, scope?) → Result<NameResolution, KoiError>` | Fast local lookup (no network) |
| `search` | `(query) → readonly NameRecord[]` | Filter projection by scope/kind/text |
| `suggest` | `(name, scope?) → readonly NameSuggestion[]` | Fuzzy "did you mean?" suggestions |
| `onChange` | `(listener) → () => void` | Subscribe to name change events |
| `dispose` | `() → void` | Stop poll timer, clear projection |

### Nexus RPC Client

Low-level JSON-RPC 2.0 transport exported for the package internals:

| Function | Nexus Method | Purpose |
|----------|-------------|---------|
| `nexusAnsRegister(config, params)` | `name.register` | Register name with binding + aliases + TTL |
| `nexusAnsRenew(config, name, scope, ttlMs?)` | `name.renew` | Refresh TTL |
| `nexusAnsDeregister(config, name, scope)` | `name.deregister` | Remove name |
| `nexusAnsList(config, zoneId?)` | `name.list` | List all names (for projection sync) |

### Error Mapping

Nexus JSON-RPC errors are mapped to `KoiErrorCode`:

| Nexus Code | Koi Code | Retryable | Meaning |
|------------|----------|-----------|---------|
| `-32006` | `CONFLICT` | yes | Name already registered |
| `-32000` | `NOT_FOUND` | no | Name does not exist |
| `-32003` | `PERMISSION` | no | Unauthorized |
| `-32005` | `VALIDATION` | no | Invalid parameters |
| HTTP 5xx | `EXTERNAL` | yes | Server-side failure |
| Timeout | `TIMEOUT` | yes | Request exceeded `timeoutMs` |

---

## Examples

### Basic Name Service Setup

```typescript
import { createNexusNameService } from "@koi/name-service-nexus";
import { agentId } from "@koi/core";

const ns = await createNexusNameService({
  baseUrl: "https://nexus.example.com",
  apiKey: process.env.NEXUS_API_KEY!,
  pollIntervalMs: 5_000,
});

// Register a name
const result = await ns.register({
  name: "code-reviewer",
  binding: { kind: "agent", agentId: agentId("a-7f3c") },
  scope: "agent",
  aliases: ["cr", "reviewer"],
  registeredBy: "system",
});

// Resolve across any node
const resolved = await ns.resolve("code-reviewer");
// { ok: true, value: { record: {...}, matchedAlias: false } }

// Resolve by alias
const aliasResult = await ns.resolve("cr");
// { ok: true, value: { record: {...}, matchedAlias: true } }

// Clean up
ns.dispose();
```

### Search and Suggestions

```typescript
// Search by binding kind
const bricks = await ns.search({ bindingKind: "brick", scope: "global" });

// Text search
const matching = await ns.search({ text: "review", limit: 10 });

// Fuzzy suggestions for typos
const suggestions = await ns.suggest("code-reviwer");
// [{ name: "code-reviewer", distance: 1, scope: "agent", ... }]
```

### Watch for Name Changes

```typescript
const ns = await createNexusNameService(config);

const unsub = ns.onChange((event) => {
  // event.kind: "registered" | "unregistered" | "renewed"
  // (no "expired" — server handles expiry, poll detects removal)
  console.log(`[ANS] ${event.kind}: ${event.name} (${event.scope})`);
});

// Later: stop watching
unsub();
```

### Testing with Injectable Fetch

```typescript
import { createNexusNameService } from "@koi/name-service-nexus";

const mockFetch: typeof fetch = async (_input, init) => {
  const body = JSON.parse(init?.body as string);
  // ... return mock JSON-RPC responses
};

const ns = await createNexusNameService({
  baseUrl: "https://nexus.test",
  apiKey: "sk-test",
  pollIntervalMs: 0,    // Disable polling in tests
  fetch: mockFetch,      // Inject mock
});
```

---

## Design Decisions

| Decision | Rationale |
|----------|-----------|
| No local TTL timers | Server handles expiry; poll detects removal. Simpler than in-memory backend's per-record `setTimeout`. |
| Write-then-project | Writes update local state immediately after Nexus confirms. Callers see their own writes without waiting for next poll. |
| Poll silently skips failures | Stale projection preferred over crash. Matches `@koi/registry-nexus` behavior. |
| 5s default poll interval | Fast enough for agent discovery (not real-time messaging). Lower than registry-nexus's 10s because name resolution is more latency-sensitive. |
| Local projection for reads | `resolve()`, `search()`, `suggest()` hit in-memory Maps — zero network latency. |
| `dispose()` is sync | Only clears interval + maps. `NameServiceBackend.dispose` allows `void \| Promise<void>`. |
| Eager warmup on creation | Factory is async and loads all names before returning. Callers never see empty projection. |
| Shared algorithms via `@koi/name-resolution` | `validateName`, `resolveByScope`, `computeSuggestions`, `compositeKey` are shared with in-memory backend. No duplication. |
| Own RPC transport (not `@koi/nexus-client`) | ANS API endpoints differ from registry. Self-contained transport avoids coupling to L0u client. Same pattern as `@koi/registry-nexus`. |
| Injectable `fetch` | Enables full unit testing with mock JSON-RPC server. No test dependency on running Nexus. |
| `maxEntries` cap | Prevents unbounded memory growth. Default 10,000 is generous for most deployments. |

---

## Comparison: In-Memory vs Nexus Backend

| Aspect | `@koi/name-service` | `@koi/name-service-nexus` |
|--------|---------------------|--------------------------|
| Scope | Single node | Multi-node (via Nexus) |
| TTL handling | Local `setTimeout` per record | Server-side; poll detects removal |
| Write path | Direct Map mutation | RPC → Nexus → local projection |
| Read path | Direct Map lookup | Local projection (same speed) |
| Startup | Synchronous | Async (loads from Nexus) |
| Change events | Immediate (sync emit) | Immediate for writes; poll-delayed for remote |
| Factory | `createInMemoryNameService()` | `createNexusNameService()` |
| Dependencies | `@koi/core`, `@koi/name-resolution`, `@koi/validation` | `@koi/core`, `@koi/name-resolution`, `@koi/validation` |

Both backends implement the same L0 `NameServiceBackend` contract — they are interchangeable.

---

## File Structure

```
packages/net/name-service-nexus/
├── package.json
├── tsconfig.json
├── tsup.config.ts
└── src/
    ├── index.ts                    # Public exports
    ├── config.ts                   # NexusNameServiceConfig + validation
    ├── config.test.ts              # Config validation tests
    ├── nexus-rpc.ts                # JSON-RPC 2.0 transport (~200 LOC)
    ├── nexus-rpc.test.ts           # RPC envelope + error mapping tests
    ├── projection.ts               # Local cache + diff logic (~190 LOC)
    ├── projection.test.ts          # Projection mutation tests
    ├── nexus-name-service.ts       # Factory + NameServiceBackend impl (~330 LOC)
    ├── nexus-name-service.test.ts  # Full backend contract tests
    └── __tests__/
        └── api-surface.test.ts     # DTS snapshot test
```
