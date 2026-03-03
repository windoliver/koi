# @koi/middleware-call-dedup — Deterministic Tool Call Result Caching

`@koi/middleware-call-dedup` is an L2 middleware package that caches results of identical deterministic tool calls within a session. When an agent calls the same tool with the same arguments multiple times, the 2nd+ call returns the cached result instantly — no network round-trip, no re-execution, no quota burn.

---

## Why It Exists

Agents frequently call the same deterministic tool multiple times per session with identical arguments. Each call executes fully — file I/O, network requests, token counting, billing. The loop guard detects *patterns* but still executes each call. This middleware caches *results*.

```
Without call-dedup:
  file_read("/config.json")  ─► execute (50ms)  ─► result A
  file_read("/config.json")  ─► execute (50ms)  ─► result A  ← wasted
  file_read("/config.json")  ─► execute (50ms)  ─► result A  ← wasted
  file_read("/config.json")  ─► execute (50ms)  ─► result A  ← wasted
  Total: 4 executions, 200ms

With call-dedup:
  file_read("/config.json")  ─► execute (50ms)  ─► result A  ← cached
  file_read("/config.json")  ─► cache hit (0ms) ─► result A  (metadata.cached = true)
  file_read("/config.json")  ─► cache hit (0ms) ─► result A  (metadata.cached = true)
  file_read("/config.json")  ─► cache hit (0ms) ─► result A  (metadata.cached = true)
  Total: 1 execution, 50ms
```

Three key mechanisms:

1. **SHA-256 cache key** — `computeContentHash({ session, tool, input })` produces a deterministic key from sessionId + toolId + input, ensuring session isolation
2. **LRU + TTL eviction** — entries expire after a configurable TTL (default 5 min) and the store caps at a max size (default 100) with LRU eviction
3. **Smart exclusion** — mutating tools (`shell_exec`, `file_write`, etc.) are excluded by default and always execute

---

## Architecture

### Layer Position

```
L0  @koi/core                        ─ KoiMiddleware, ToolRequest, ToolResponse,
                                         TurnContext, CapabilityFragment (types only)
L0u @koi/hash                        ─ computeContentHash (SHA-256)
L0u @koi/resolve                     ─ BrickDescriptor (manifest auto-resolution)
L2  @koi/middleware-call-dedup       ─ this package (no L1 dependency)
```

### Internal Module Map

```
index.ts                    ← public re-exports
│
├── types.ts                ← CallDedupStore, CacheEntry, CacheHitInfo
├── config.ts               ← CallDedupConfig, DEFAULT_EXCLUDE, validateCallDedupConfig
├── store.ts                ← createInMemoryDedupStore (Map-backed LRU)
├── call-dedup.ts           ← createCallDedupMiddleware() factory
└── descriptor.ts           ← BrickDescriptor for manifest auto-resolution
```

### Middleware Priority

```
170 ─ (available)
175 ─ call-limits        ← enforce call count budgets
185 ─ call-dedup         ← this package (cache after limit check)
200 ─ pay                ← billing
225 ─ compactor          ← context compaction
```

The dedup middleware runs at priority 185 — after call-limits (175) so a deduplicated call does not consume the call budget, but before pay (200) so cached results bypass billing.

---

## How It Works

### Cache Key Generation

Each cache key is derived from three components to ensure correctness and session isolation:

```
cacheKey = SHA-256({ session: sessionId, tool: toolId, input: { ... } })
```

The deterministic serialization in `computeContentHash` sorts object keys recursively, so `{ a: 1, b: 2 }` and `{ b: 2, a: 1 }` produce the same hash.

### wrapToolCall Flow

```
Request arrives
  │
  ├─ Tool excluded? ──────────────────► next(request)  (always execute)
  │
  ├─ Include list exists & tool not in it? ─► next(request)  (skip cache)
  │
  ├─ Compute cache key (sessionId + toolId + input)
  │
  ├─ Cache hit & not expired? ────────► return cached response
  │   │                                  (metadata.cached = true)
  │   │                                  (fire onCacheHit callback)
  │   │
  │   └─ Expired? ────────────────────► delete stale entry, fall through
  │
  ├─ Execute next(request)
  │   │
  │   ├─ Tool threw? ─────────────────► re-throw (never cache exceptions)
  │   │
  │   ├─ Response blocked/error? ─────► return without caching
  │   │
  │   └─ Success ─────────────────────► store result, return response
  │
  └─ (unreachable)
```

### Default Exclusions

These tools are excluded from caching by default because they are side-effecting:

| Tool | Reason |
|------|--------|
| `shell_exec` | Executes shell commands with side effects |
| `file_write` | Writes to filesystem |
| `file_delete` | Deletes files |
| `file_create` | Creates files |
| `agent_send` | Sends messages to other agents |
| `agent_spawn` | Spawns new agent processes |

User-supplied `exclude` entries are merged with these defaults.

---

## API Reference

### `createCallDedupMiddleware(config?)`

Factory function that creates a `KoiMiddleware` with a `wrapToolCall` hook.

```typescript
import { createCallDedupMiddleware } from "@koi/middleware-call-dedup";

const dedup = createCallDedupMiddleware({
  ttlMs: 60_000,        // 1 minute TTL (default: 300_000 = 5 min)
  maxEntries: 50,        // LRU capacity (default: 100)
  exclude: ["my_tool"],  // merged with DEFAULT_EXCLUDE
  onCacheHit: (info) => console.log(`Hit: ${info.toolId}`),
});
```

Returns `KoiMiddleware` with:
- `name`: `"koi:call-dedup"`
- `priority`: `185`
- `wrapToolCall`: cache-or-execute logic
- `describeCapabilities`: returns `{ label: "call-dedup", description: "..." }`

### `CallDedupConfig`

```typescript
interface CallDedupConfig {
  readonly ttlMs?: number;           // Cache TTL in ms (default: 300_000)
  readonly maxEntries?: number;      // Max cache entries (default: 100)
  readonly include?: readonly string[];  // Whitelist (undefined = all non-excluded)
  readonly exclude?: readonly string[];  // Blacklist (merged with DEFAULT_EXCLUDE)
  readonly hashFn?: (sessionId: string, toolId: string, input: JsonObject) => string;
  readonly now?: () => number;       // Clock injection for testing
  readonly store?: CallDedupStore;   // Custom store (default: in-memory LRU)
  readonly onCacheHit?: (info: CacheHitInfo) => void;
}
```

### `createInMemoryDedupStore(maxEntries)`

Creates a Map-backed LRU store with sync operations:

```typescript
import { createInMemoryDedupStore } from "@koi/middleware-call-dedup";

const store = createInMemoryDedupStore(200);
```

### `CallDedupStore`

Interface for custom store implementations (e.g., Redis-backed):

```typescript
interface CallDedupStore {
  readonly get: (key: string) => CacheEntry | undefined | Promise<CacheEntry | undefined>;
  readonly set: (key: string, entry: CacheEntry) => void | Promise<void>;
  readonly delete: (key: string) => boolean | Promise<boolean>;
  readonly size: () => number | Promise<number>;
  readonly clear: () => void | Promise<void>;
}
```

### `validateCallDedupConfig(config)`

Validates raw input (e.g., from YAML) into a typed config:

```typescript
const result = validateCallDedupConfig({ ttlMs: 60000 });
if (result.ok) {
  const config = result.value; // CallDedupConfig
}
```

---

## Examples

### Manifest-Driven (koi.yaml)

```yaml
middleware:
  - name: call-dedup
    options:
      ttlMs: 60000
      exclude: [my_custom_mutation_tool]
```

No code changes needed — the `BrickDescriptor` handles resolution automatically.

### Programmatic Factory

```typescript
import { createCallDedupMiddleware } from "@koi/middleware-call-dedup";

const dedup = createCallDedupMiddleware({
  ttlMs: 120_000,
  include: ["file_read", "web_search", "code_search"],
  onCacheHit: ({ toolId, sessionId }) => {
    metrics.increment("cache_hit", { tool: toolId, session: sessionId });
  },
});
```

### With Custom Store

```typescript
import type { CallDedupStore } from "@koi/middleware-call-dedup";
import { createCallDedupMiddleware } from "@koi/middleware-call-dedup";

const redisStore: CallDedupStore = {
  async get(key) { /* Redis GET + JSON parse */ },
  async set(key, entry) { /* Redis SET with TTL */ },
  async delete(key) { /* Redis DEL */ },
  async size() { /* Redis DBSIZE */ },
  async clear() { /* Redis FLUSHDB */ },
};

const dedup = createCallDedupMiddleware({ store: redisStore });
```

---

## What This Feature Enables

### 1. Reduced Latency
Cached tool calls return instantly (sub-millisecond) instead of waiting for I/O. An agent that reads the same file 5 times per session saves 4 round-trips.

### 2. Lower Cost
Deduplicated calls skip billing middleware (priority 185 < pay at 200). For agents using metered APIs (web search, code search), this directly reduces token and API costs.

### 3. Quota Preservation
Rate-limited tools (call-limits middleware at priority 175) count each execution. Cached responses don't reach the tool executor, so they don't consume the quota budget.

### 4. Deterministic Behavior
Same input always produces the same cached output within the TTL window, reducing non-determinism in multi-turn agent sessions.

### 5. Session Isolation
Cache keys include `sessionId`, so agent A's cached results never leak into agent B's session — even if they call the same tool with the same input.

---

## Layer Compliance

```
@koi/middleware-call-dedup imports:
  ✅ @koi/core      (L0)  — KoiMiddleware, ToolRequest, ToolResponse, etc.
  ✅ @koi/hash       (L0u) — computeContentHash
  ✅ @koi/resolve    (L0u) — BrickDescriptor
  ❌ @koi/engine     (L1)  — NOT imported
  ❌ peer L2          —      NOT imported
```

All interface properties are `readonly`. No vendor types. No framework-isms.
