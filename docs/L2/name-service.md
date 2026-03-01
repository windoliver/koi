# @koi/name-service — DNS-like Discovery for Agents and Forged Bricks

Maps human-readable names to `AgentId` (running agents) and `BrickId` (forged bricks), with scoped visibility, aliases, TTL-based expiry, and "did you mean?" fuzzy suggestions. Think DNS for your agent fleet — go from `"code-reviewer"` to the running agent ID without iterating the entire registry.

Informed by the [IETF ANS draft](https://datatracker.ietf.org/doc/html/draft-narajala-ans-00) (TTL defaults, resolution algorithm) and [Microsoft Multi-Agent Reference Architecture](https://microsoft.github.io/multi-agent-reference-architecture/docs/agent-registry/Agent-Registry.html) (registry patterns).

---

## Why It Exists

Koi's `AgentRegistry` is ID-only — it manages lifecycle state transitions keyed by `AgentId`. Agent names exist in `ProcessId.name` but are metadata-only and not indexed. There is no way to go from `"code-reviewer"` to an `AgentId` without scanning every registry entry.

Without this package, you'd need to:
1. Iterate all `AgentRegistry` entries to find an agent by name
2. Manually track name-to-ID mappings outside the registry
3. Handle scoped name resolution (agent-local vs zone vs global) yourself
4. Build your own alias system for short names like `"cr"` → `"code-reviewer"`
5. Implement TTL-based cleanup to avoid stale name bindings
6. Write fuzzy matching from scratch for typo suggestions

---

## What This Enables

### Name-Based Agent Discovery

```
  System code                     ANS                          AgentRegistry
  ───────────                     ───                          ─────────────

  resolve("code-reviewer")  ──►  Lookup by scope priority     (no scan needed)
                                  agent: code-reviewer? ✓
                                    │
                                    ▼
                             NameResolution {
                               record: { name, binding, scope, ... }
                               matchedAlias: false
                               matchedName: "code-reviewer"
                             }
                                    │
                                    ▼
                             binding.agentId = "a-7f3c"  ──►  registry.lookup("a-7f3c")
```

### Scoped Resolution (Agent → Zone → Global)

```
  Three agents register the name "helper":
  ──────────────────────────────────────────

  agent scope:   helper → agentId("local-helper")     ← priority 0
  zone scope:    helper → agentId("zone-helper")      ← priority 1
  global scope:  helper → agentId("global-helper")    ← priority 2

  resolve("helper")              → local-helper    (agent scope wins)
  resolve("helper", "global")   → global-helper   (explicit scope)
  resolve("helper", "zone")     → zone-helper     (explicit scope)

  Agent-scoped names shadow zone, which shadow global.
  Same precedence model as DNS search domains.
```

### Both Agents and Bricks

```
  NameBinding (discriminated union)
  ─────────────────────────────────

  { kind: "agent", agentId: AgentId }
    └── running agent, resolved at runtime

  { kind: "brick", brickId: BrickId, brickKind: BrickKind }
    └── forged artifact (tool, skill, agent, middleware, channel)
        resolved from the brick store
```

### Aliases and Fuzzy Suggestions

```
  Register:
    name: "code-reviewer"
    aliases: ["cr", "reviewer"]

  resolve("cr")        → code-reviewer  (matchedAlias: true)
  resolve("reviewer")  → code-reviewer  (matchedAlias: true)

  resolve("code-reviwer")  → NOT_FOUND
  suggest("code-reviwer")  → [
    { name: "code-reviewer", distance: 1, scope: "agent", ... }
  ]
```

### TTL-Based Expiry

```
  Register with TTL:
    name: "ephemeral-worker"
    ttlMs: 300_000  (5 min, IETF ANS default)

  0s:    resolve("ephemeral-worker")  → OK
  299s:  resolve("ephemeral-worker")  → OK
  301s:  resolve("ephemeral-worker")  → NOT_FOUND
         onChange event: { kind: "expired", name: "ephemeral-worker", ... }

  Renew to extend:
    renew("ephemeral-worker", "agent", 600_000)  → resets timer to 10 min
```

### Automatic Registry Sync

```
  AgentRegistry                    createRegistrySync()              ANS
  ─────────────                    ────────────────────              ───

  register(entry) ──► "registered" event ──► nameService.register({
                                               name: entry.metadata.name,
                                               binding: { kind: "agent", agentId },
                                               scope: "agent"
                                             })

  deregister(id)  ──► "deregistered" event ──► nameService.unregister(name, scope)

  One line to wire:
    const unsub = createRegistrySync(registry, nameService);
```

---

## Architecture

`@koi/name-service` is an **L2 feature package** — it depends on `@koi/core` (L0) for types and `@koi/validation` (L0u) for Levenshtein distance. The L0 contracts live in `@koi/core/src/name-service.ts`.

```
┌───────────────────────────────────────────────────────────────────────┐
│  @koi/core (L0) — name-service.ts                                     │
│                                                                       │
│  Types: NameBinding, NameRecord, NameResolution, NameSuggestion,     │
│         NameQuery, NameChangeEvent, AnsConfig, NameRegistration       │
│                                                                       │
│  Interfaces: NameServiceReader (agent-facing)                         │
│              NameServiceWriter (system-facing)                        │
│              NameServiceBackend (combined)                            │
│                                                                       │
│  Constants: DEFAULT_ANS_CONFIG, ANS_SCOPE_PRIORITY                   │
│                                                                       │
│  ECS token: NAME_SERVICE: SubsystemToken<NameServiceReader>          │
├───────────────────────────────────────────────────────────────────────┤
│  @koi/name-service (L2)                                               │
│                                                                       │
│  Pure functions (zero side effects)                                   │
│  ┌──────────────────┐ ┌──────────────────┐ ┌──────────────────┐     │
│  │ name-validation  │ │ composite-key    │ │ scope-resolver   │     │
│  │                  │ │                  │ │                  │     │
│  │ validateName()   │ │ compositeKey()   │ │ resolveByScope() │     │
│  │ regex + length   │ │ parseComposite() │ │ priority order   │     │
│  └──────────────────┘ └──────────────────┘ └──────────────────┘     │
│                                                                       │
│  ┌──────────────────┐ ┌──────────────────┐                           │
│  │ fuzzy-matcher    │ │ expiry-scheduler │                           │
│  │                  │ │                  │                           │
│  │ computeSuggest() │ │ createExpiry()   │                           │
│  │ Levenshtein dist │ │ per-record timer │                           │
│  └──────────────────┘ └──────────────────┘                           │
│                                                                       │
│  Backend                                                              │
│  ┌──────────────────────────────────────────────────────┐            │
│  │ in-memory-backend.ts                                  │            │
│  │                                                       │            │
│  │ createInMemoryNameService(config?)                    │            │
│  │   → NameServiceBackend                                │            │
│  │                                                       │            │
│  │ register, resolve, search, suggest,                   │            │
│  │ unregister, renew, onChange, dispose                   │            │
│  └──────────────────────────────────────────────────────┘            │
│                                                                       │
│  Integration                                                          │
│  ┌──────────────────────────┐ ┌──────────────────────────┐          │
│  │ component-provider.ts    │ │ registry-sync.ts         │          │
│  │                          │ │                          │          │
│  │ createNameService-       │ │ createRegistrySync()     │          │
│  │ Provider(backend)        │ │   registry + writer      │          │
│  │   → ComponentProvider    │ │   → () => void (unsub)   │          │
│  │   (reader-only view)     │ │                          │          │
│  └──────────────────────────┘ └──────────────────────────┘          │
│                                                                       │
├───────────────────────────────────────────────────────────────────────┤
│  Dependencies                                                         │
│  @koi/core (L0)         NameBinding, NameRecord, Result, KoiError,   │
│                          ForgeScope, AgentId, BrickId, etc.           │
│  @koi/validation (L0u)  levenshteinDistance() for fuzzy matching      │
└───────────────────────────────────────────────────────────────────────┘
```

### Reader/Writer Separation

The backend implements both `NameServiceReader` and `NameServiceWriter`. Agents only see the reader via the ECS component — they can resolve names but cannot register, unregister, or renew.

```
  NameServiceBackend (full API)
  ├── NameServiceReader (exposed to agents via NAME_SERVICE token)
  │     resolve()   — name → binding
  │     search()    — query → records[]
  │     suggest()   — typo → suggestions[]
  │     onChange()   — subscribe to changes
  │
  └── NameServiceWriter (used by system code only)
        register()   — bind a name
        unregister() — remove a name
        renew()      — extend TTL
```

---

## Configuration

```typescript
interface AnsConfig {
  defaultTtlMs: number;          // Default: 300_000 (5 min, per IETF ANS draft)
  maxAliasesPerName: number;     // Default: 10
  maxSuggestionDistance: number;  // Default: 3 (Levenshtein)
  maxSuggestions: number;        // Default: 5
  maxRecords: number;            // Default: 10_000 (safety valve)
}
```

All defaults are in `DEFAULT_ANS_CONFIG`. Pass a partial config to override:

```typescript
const ns = createInMemoryNameService({
  defaultTtlMs: 0,         // no expiry
  maxRecords: 1_000,       // smaller fleet
});
```

---

## Name Validation

Names must match `/^[a-z][a-z0-9-]*$/`:

| Valid | Invalid | Why |
|-------|---------|-----|
| `reviewer` | `Reviewer` | uppercase |
| `code-reviewer` | `code_reviewer` | underscore |
| `agent1` | `1agent` | starts with digit |
| `my-tool-v2` | `agent:reviewer` | colon (reserved for composite keys) |
| `a` | `` (empty) | empty |

Max length: 128 characters.

---

## Examples

### Basic Registration and Resolution

```typescript
import { createInMemoryNameService } from "@koi/name-service";
import { agentId } from "@koi/core";

const ns = createInMemoryNameService({ defaultTtlMs: 0 });

// Register an agent
ns.register({
  name: "code-reviewer",
  binding: { kind: "agent", agentId: agentId("a-7f3c") },
  scope: "agent",
  aliases: ["cr"],
  registeredBy: "system",
});

// Resolve by name
const result = await ns.resolve("code-reviewer");
// { ok: true, value: { record: {...}, matchedAlias: false, matchedName: "code-reviewer" } }

// Resolve by alias
const aliasResult = await ns.resolve("cr");
// { ok: true, value: { record: {...}, matchedAlias: true, matchedName: "cr" } }
```

### ECS Component Provider

```typescript
import { createInMemoryNameService, createNameServiceProvider } from "@koi/name-service";

const backend = createInMemoryNameService();
const provider = createNameServiceProvider(backend);

// Pass to agent assembly
createKoi({
  providers: [provider, ...otherProviders],
});

// Inside agent code, access via ECS:
const reader = agent.get(NAME_SERVICE);
const result = await reader.resolve("my-tool");
```

### Registry Sync

```typescript
import { createInMemoryNameService, createRegistrySync } from "@koi/name-service";

const ns = createInMemoryNameService();

// Mirror registry events into ANS
const unsub = createRegistrySync(registry, ns, {
  defaultScope: "zone",
  registeredBy: "auto-sync",
});

// Agents registered in the registry are now discoverable by name
const result = await ns.resolve("code-reviewer", "zone");

// Stop syncing
unsub();
```

### Search and Suggestions

```typescript
// Search by criteria
const tools = await ns.search({ bindingKind: "brick", scope: "global" });
const matching = await ns.search({ text: "review", limit: 10 });

// Fuzzy suggestions for typos
const suggestions = await ns.suggest("code-reviwer");
// [{ name: "code-reviewer", distance: 1, scope: "agent", binding: {...} }]
```

---

## Performance

### Resolution: O(1) per scope

```
resolve("code-reviewer")
  │
  ├── Check agent scope:  Map.get("agent:code-reviewer")    O(1)
  │   found? → return immediately
  │
  ├── Check zone scope:   Map.get("zone:code-reviewer")     O(1)
  │   found? → return immediately
  │
  └── Check global scope: Map.get("global:code-reviewer")   O(1)
      found? → return immediately
      not found? → NOT_FOUND

Worst case: 3 Map lookups + 3 alias Map lookups = 6 O(1) operations.
```

### Timer Scaling

Each record with a TTL gets its own `setTimeout`. Timers are `unref()`'d so they don't keep the process alive. The `maxRecords` safety valve (default: 10,000) prevents unbounded timer growth.

```
10,000 records × 1 timer each = 10,000 timers
  → well within V8/Bun timer capacity
  → each timer: ~200 bytes = ~2 MB total

dispose() clears all timers in O(n) — called once at shutdown.
```

### Fuzzy Matching: O(n × m)

Suggestions scan all records (n) and compute Levenshtein distance for each name/alias (m total strings). The `maxDistance` early-exit optimization in `levenshteinDistance()` prunes most comparisons quickly.

```
10,000 records, avg 2 aliases each = 30,000 strings
levenshteinDistance with maxDistance=3: early-exit when len diff > 3
  → most comparisons short-circuit in O(1)
  → worst case: O(30,000 × max(nameLen, queryLen))
```

---

## Layer Compliance

```
L0  @koi/core ─────────────────────────────────────────────────────┐
    name-service.ts — types + interfaces only (no function bodies)  │
    ecs.ts — NAME_SERVICE: SubsystemToken<NameServiceReader>        │
                                                                    │
L0u @koi/validation ────────────────────────────────────────────────┤
    levenshteinDistance() — reused for fuzzy matching                │
                                                                    │
L2  @koi/name-service ◄────────────────────────────────────────────┘
    imports from L0 + L0u only
    ✗ never imports @koi/engine (L1)
    ✗ never imports peer L2 packages
    ✓ @koi/core + @koi/validation are the sole workspace deps
```

---

## Change Events

Subscribe to name changes for monitoring, logging, or reactive updates:

```typescript
const unsub = ns.onChange((event) => {
  // event.kind: "registered" | "unregistered" | "expired" | "renewed"
  // event.name: string
  // event.scope: ForgeScope
  // event.binding?: NameBinding
  console.log(`[ANS] ${event.kind}: ${event.name} (${event.scope})`);
});

// Later: stop listening
unsub();
```

Events are dispatched synchronously to all listeners, matching existing Koi patterns (e.g., `AgentRegistry.watch()`).

---

## Error Handling

All expected failures return `Result<T, KoiError>`:

| Scenario | Error Code | Retryable |
|----------|-----------|-----------|
| Name not found | `NOT_FOUND` | No |
| Name already registered (different binding) | `CONFLICT` | Yes (merge) |
| Alias collides with existing name/alias | `CONFLICT` | Yes (merge) |
| Invalid name format | `VALIDATION` | No |
| Too many aliases | `VALIDATION` | No |
| Max records reached | `RATE_LIMIT` | Yes (backoff) |

Idempotent: registering the same name with the same binding is a no-op (returns existing record).
