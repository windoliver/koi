# @koi/middleware-permissions — Tool-Level Access Control + HITL Approval

Checks allow/deny/ask patterns before tool execution. Supports human-in-the-loop approval for sensitive operations. Opt-in approval cache with policy-aware, identity-scoped, TTL-based invalidation.

---

## Why It Exists

When an agent has access to tools, some tools are safe (read files), some are dangerous (delete database), and some need a human to say "yes" first (deploy to production). Without a permissions layer, every agent implementer reinvents:

1. **Pattern matching** — "which tools need approval?"
2. **Approval flow** — "how do I ask the human and wait?"
3. **Caching** — "don't re-ask for the same thing every 5 seconds"

This middleware handles all three as a composable `KoiMiddleware` with a single `wrapToolCall` hook.

---

## Architecture

`@koi/middleware-permissions` is an **L2 feature package** — it depends on L0 (`@koi/core`) and L0u utilities (`@koi/errors`, `@koi/hash`). Zero external dependencies.

```
+----------------------------------------------------------+
|  @koi/middleware-permissions  (L2)                        |
|                                                          |
|  engine.ts       <- PermissionEngine + pattern matching  |
|  config.ts       <- config types + validation            |
|  permissions.ts  <- middleware factory + approval cache   |
|  hash.ts         <- re-export fnv1a from @koi/hash       |
|  descriptor.ts   <- BrickDescriptor for auto-resolution  |
|  index.ts        <- public API surface                   |
|                                                          |
+---------------------------+------------------------------+
|  Dependencies             |                              |
|                           |                              |
|  @koi/core   (L0)        |  KoiMiddleware, ToolRequest, |
|                           |  ToolResponse, TurnContext   |
|  @koi/errors (L0u)       |  KoiRuntimeError             |
|  @koi/hash   (L0u)       |  fnv1a (cache key hashing)   |
+---------------------------+------------------------------+
```

---

## How It Works

### Decision Flow

Every tool call passes through this decision tree:

```
Tool call: deploy(env: "prod")
      |
      v
+-----------------+
| PermissionEngine|
| .check()        |
+--------+--------+
         |
    +----+----+----------+
    |         |          |
    v         v          v
  ALLOW     DENY       ASK
    |         |          |
    v         v          v
 next()    throw      cache lookup
           PERMISSION     |
                     +----+----+
                     |         |
                     v         v
                   HIT       MISS
                     |         |
                     v         v
                  next()   approvalHandler
                            .requestApproval()
                                |
                           +----+----+
                           |         |
                           v         v
                        APPROVED   DENIED
                           |         |
                           v         v
                        cache it   throw
                        next()     PERMISSION
```

### Pattern Matching (Deny-First)

The engine evaluates rules in priority order:

```
Rules: { allow: ["calc", "read:*"],
         deny:  ["rm", "fs:*"],
         ask:   ["deploy", "send:*"] }

Tool call       Evaluation path                Result
-----------     ----------------------------   -------
calc            deny? no -> ask? no -> allow   ALLOW
rm              deny? YES                      DENY
fs:delete       deny? fs:* YES                 DENY
deploy          deny? no -> ask? YES           ASK
send:email      deny? no -> ask? send:* YES    ASK
read:config     deny? no -> ask? no -> allow   ALLOW
unknown         deny? no -> ask? no -> allow?  ALLOW (or DENY if defaultDeny)
                no -> defaultDeny
```

### Middleware Position (Onion)

```
            Incoming Tool Call
                   |
                   v
       +-----------------------+
       |   guard middleware    |  priority: 0-99
       +-----------------------+
       |   middleware-         |  priority: 100
       |   permissions (THIS) |  <-- blocks before anything else runs
       +-----------------------+
       |   middleware-audit    |  priority: 200+
       +-----------------------+
       |   engine adapter     |
       |   -> tool.execute()  |
       +-----------+-----------+
              Response
```

Priority 100 means permissions runs early in the onion — tool calls that are denied never reach downstream middleware or the actual tool executor.

---

## Approval Cache

The cache is opt-in (disabled by default) and stores only approvals (never denials).

### The Problem It Solves

Without caching, every "ask" tool call prompts the human — even if they approved the exact same call 2 seconds ago. In long-running agent sessions (#134), this becomes unusable.

### The Stale Authorization Problem

A naive cache keyed by `(toolId, input)` has three security holes:

```
BEFORE (broken cache key)
=========================

cache key = hash(toolId + input)

  Alice                 Bob
    |                     |
    +-- deploy(prod) -----+
    |   ask -> approve    |
    |   cached            |
    |                     |
    |                     +-- deploy(prod) ----+
    |                     |   CACHE HIT!       |
    |                     |   Bob rides Alice's|
    |                     |   approval         |
    |                     |                    |
    v                     v

Problem 1: Bob uses Alice's cached approval (identity leak)
Problem 2: If rules change, old approvals survive (stale policy)
Problem 3: Approvals never expire (no time bound)
```

### Three-Dimensional Cache Key

The fix includes three dimensions in the cache key:

```
cache key = fnv1a(rulesFingerprint \0 userId \0 toolId \0 input)
                  ^^^^^^^^^^^^^^^^    ^^^^^^    ^^^^^^    ^^^^^
                  policy dimension    identity  tool      input
                                      dimension dimension dimension

+---------------------+-------------------------------------+
| Stale scenario      | Defense                             |
+---------------------+-------------------------------------+
| Rules changed       | Different fingerprint -> cache miss |
| User switched       | Different userId -> cache miss      |
| Time passed         | TTL expired -> evict + re-prompt    |
+---------------------+-------------------------------------+
```

### How Each Dimension Works

**Policy fingerprint** — computed once at middleware construction:

```
rulesFingerprint = fnv1a(JSON.stringify([
  [...rules.allow].sort(),
  [...rules.deny].sort(),
  [...rules.ask].sort(),
]))
```

Since `rules` is `readonly`, the fingerprint is stable for the middleware's lifetime. A new middleware instance with different rules gets a different fingerprint.

**Identity** — read per-call from the `TurnContext`:

```
userId = ctx.session.userId ?? "__anonymous__"
```

Anonymous and authenticated users produce different cache keys. Switching users mid-session causes cache misses.

**Input serialization** — top-level input keys are sorted before `JSON.stringify`:

```
{ b: 8, a: 7 }  →  sorted  →  { a: 7, b: 8 }  →  '{"a":7,"b":8}'
{ a: 7, b: 8 }  →  sorted  →  { a: 7, b: 8 }  →  '{"a":7,"b":8}'  ← same key
```

Property insertion order is an implementation detail. Both calls above hit the same cache entry.
If the input is not JSON-serializable (e.g. contains a circular reference), the middleware throws
a `VALIDATION` error before the approval prompt is shown.

**TTL** — checked on every cache hit:

```
expired = ttlMs > 0 && Date.now() - entry.cachedAt >= ttlMs
```

Default: 5 minutes (300,000ms). Set `ttlMs: 0` to disable expiry.

### LRU Eviction

The cache uses Map insertion-order as an LRU:

```
Cache (maxEntries: 3)

State after 3 approvals:
  [A] -> [B] -> [C]        (A is oldest)

Access B (cache hit):
  delete B, reinsert at end
  [A] -> [C] -> [B]

New entry D (cache full, evict oldest):
  delete A (first key in Map)
  [C] -> [B] -> [D]
```

---

## API Reference

### Factory

#### `createPermissionsMiddleware(config)`

Creates the middleware. Cache state lives in the closure — one middleware instance = one cache.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `config.engine` | `PermissionEngine` | (required) | Pattern matcher |
| `config.rules` | `PermissionRules` | (required) | `{ allow, deny, ask }` string arrays |
| `config.approvalHandler` | `ApprovalHandler` | `undefined` | HITL callback (required if `ask` is non-empty) |
| `config.approvalTimeoutMs` | `number` | `30_000` | Timeout for approval requests |
| `config.defaultDeny` | `boolean` | `false` | Deny unmatched tools (vs allow) |
| `config.approvalCache` | `boolean \| ApprovalCacheConfig` | `false` | Enable approval caching |

**Returns:** `KoiMiddleware`

#### `createPatternPermissionEngine(defaultDeny?)`

Creates the default pattern-matching engine. Evaluation order: deny-first, then ask, then allow, then defaultDeny.

#### `createAutoApprovalHandler()`

Always approves. For testing and development only.

#### `validatePermissionsConfig(config)`

Validates config shape and returns `Result<PermissionsMiddlewareConfig, KoiError>`.

### Interfaces

#### `PermissionRules`

```typescript
interface PermissionRules {
  readonly allow: readonly string[]  // Glob patterns: "calc", "read:*", "*"
  readonly deny: readonly string[]   // Deny-first: checked before allow
  readonly ask: readonly string[]    // Requires human approval
}
```

#### `ApprovalHandler`

```typescript
interface ApprovalHandler {
  readonly requestApproval: (
    toolId: string,
    input: JsonObject,
    reason: string,
  ) => Promise<boolean>
}
```

#### `ApprovalCacheConfig`

```typescript
interface ApprovalCacheConfig {
  readonly maxEntries?: number  // Default: 256. LRU eviction when full.
  readonly ttlMs?: number       // Default: 300_000 (5 min). 0 = no expiry.
}
```

### Constants

| Constant | Value | Description |
|----------|-------|-------------|
| `DEFAULT_APPROVAL_CACHE_MAX_ENTRIES` | `256` | Max cached approvals |
| `DEFAULT_APPROVAL_CACHE_TTL_MS` | `300_000` | 5-minute TTL |

---

## Examples

### Basic Allow/Deny

```typescript
import { createPatternPermissionEngine, createPermissionsMiddleware } from "@koi/middleware-permissions";

const mw = createPermissionsMiddleware({
  engine: createPatternPermissionEngine(),
  rules: {
    allow: ["calc", "read:*"],
    deny: ["rm", "fs:delete"],
    ask: [],
  },
});

const agent = await createKoi({
  manifest,
  adapter,
  middleware: [mw],
});
```

### Human-in-the-Loop with Caching

```typescript
import {
  createPatternPermissionEngine,
  createPermissionsMiddleware,
} from "@koi/middleware-permissions";

const mw = createPermissionsMiddleware({
  engine: createPatternPermissionEngine(),
  rules: {
    allow: ["read:*"],
    deny: ["rm"],
    ask: ["deploy", "send:*"],
  },
  approvalHandler: {
    requestApproval: async (toolId, input, reason) => {
      // Show UI prompt, wait for user response
      return await showApprovalDialog({ toolId, input, reason });
    },
  },
  approvalCache: true, // defaults: maxEntries=256, ttlMs=300_000
});
```

### Custom Cache Config

```typescript
const mw = createPermissionsMiddleware({
  engine: createPatternPermissionEngine(),
  rules: { allow: [], deny: [], ask: ["deploy"] },
  approvalHandler: myHandler,
  approvalCache: {
    maxEntries: 64,    // smaller cache
    ttlMs: 60_000,     // 1-minute TTL (stricter)
  },
});
```

### TTL Disabled (Session-Lifetime Cache)

```typescript
const mw = createPermissionsMiddleware({
  engine: createPatternPermissionEngine(),
  rules: { allow: [], deny: [], ask: ["deploy"] },
  approvalHandler: myHandler,
  approvalCache: {
    ttlMs: 0, // never expires — lives for middleware lifetime
  },
});
```

### Default Deny (Allowlist Mode)

```typescript
const mw = createPermissionsMiddleware({
  engine: createPatternPermissionEngine(/* defaultDeny */ true),
  rules: {
    allow: ["calc", "read:config"],
    deny: [],
    ask: [],
  },
  defaultDeny: true, // any tool not in allow list is blocked
});
```

### With Other Middleware

```typescript
const agent = await createKoi({
  manifest,
  adapter,
  middleware: [
    createPermissionsMiddleware({ ... }),           // priority: 100 (runs first)
    createAuditMiddleware({ ... }),                 // priority: 200
    createSemanticRetryMiddleware({ ... }).middleware, // priority: 420
  ],
  userId: "alice-123", // injected into ctx.session.userId for cache key
});
```

---

## Hot Path Performance

The middleware adds near-zero overhead on the allow/deny fast paths:

```
wrapToolCall(ctx, request, next):
  |
  +-- engine.check() -> allowed?
  |     |
  |     +-- true  -> return next(request)     <- 1 function call, straight through
  |     +-- false -> throw PERMISSION         <- immediate, no cache lookup
  |     +-- "ask" -> cache lookup             <- only "ask" tools hit the cache
  |                    |
  |                    +-- HIT + not expired  -> return next(request)
  |                    +-- MISS or expired    -> approvalHandler (human)
```

**Allow path:** 1 pattern match + delegate to `next()`. Zero allocations.

**Deny path:** 1 pattern match + throw. Zero allocations.

**Ask path (cache hit):** 1 pattern match + `computeCacheKey` (~150us) + Map.get + TTL check. One string allocation for the key.

**Ask path (cache miss):** + human approval latency (~30 seconds). Cache overhead is <0.001% of total.

Cache entry memory: 16 bytes per entry. 256 entries = 4KB total.

---

## Testing

```bash
# Unit tests (fast, no API key needed)
bun test --cwd packages/middleware-permissions

# E2E with real LLM (requires ANTHROPIC_API_KEY in .env)
E2E_TESTS=1 bun test --cwd packages/middleware-permissions src/__tests__/e2e-approval-cache.test.ts
```

### Test Coverage

| Area | Tests | What's Verified |
|------|-------|-----------------|
| Config validation | 17 | All fields validated, edge cases |
| Permission decisions | 12 | Allow/deny/ask/wildcard/defaultDeny |
| Approval flow | 4 | Approve, deny, timeout, no-handler |
| Cache basics | 6 | Hit, miss, different input, denial not cached, LRU |
| Cache identity | 2 | userId isolation, anonymous -> authenticated |
| Cache TTL | 2 | Expiry after ttlMs, ttlMs=0 disables |
| Cache policy | 1 | Different rules fingerprint -> miss |
| E2E (deterministic) | 7 | Full createKoi + createLoopAdapter stack |
| E2E (real LLM) | 3 | Full createKoi + createPiAdapter + Anthropic Haiku |

---

## Layer Compliance

```
L0  @koi/core -----------------------------------------------+
    KoiMiddleware, ToolRequest, ToolResponse, TurnContext     |
                                                              |
L0u @koi/errors, @koi/hash ----------------------------------+
    KoiRuntimeError, fnv1a                                    |
                                                              v
L2  @koi/middleware-permissions <-----------------------------+
    imports from L0 and L0u only
    x never imports @koi/engine (L1)
    x never imports peer L2 packages (except @koi/resolve for descriptor type)
    x zero external dependencies
```

**Dev-only dependencies** (`@koi/test-utils`, `@koi/engine`, `@koi/engine-loop`, `@koi/engine-pi`) are used in tests but are not runtime imports.
