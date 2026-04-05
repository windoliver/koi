# @koi/middleware-permissions — Tool-Level Access Control + Human-in-the-Loop Approval

Controls which tools an AI agent is allowed to use. Sits between the LLM and tools, enforcing allow/deny/ask policies with pluggable backends, decision caching, audit logging, and circuit breaker resilience.

---

## Why It Exists

An agent with access to `bash`, `fs:delete`, `fetch`, and `multiply` can use **all of them freely** by default. That's dangerous — you probably don't want an agent deleting files or running shell commands without oversight.

This middleware solves three problems:

1. **Tool filtering** — denied tools are invisible to the LLM (it never knows they exist)
2. **Human gating** — sensitive tools pause execution until a human approves or rejects
3. **Fail-closed semantics** — if the permission system is down, everything is denied (not allowed)

Without this package, every agent would reimplement tool filtering, approval flows, caching, and resilience logic.

---

## Architecture

`@koi/middleware-permissions` is an **L2 feature package** — it depends only on L0 (`@koi/core`) and L0u utilities (`@koi/errors`, `@koi/hash`). Zero external dependencies.

```
┌────────────────────────────────────────────────────────────┐
│  @koi/middleware-permissions  (L2)                          │
│                                                            │
│  config.ts          ← config interface + validation        │
│  classifier.ts     ← pattern backend + approval handler   │
│  denial-tracker.ts ← per-session denial accumulator       │
│  middleware.ts     ← middleware factory (core logic)      │
│  index.ts           ← public API surface                   │
│                                                            │
├────────────────────────────────────────────────────────────┤
│  Dependencies                                              │
│                                                            │
│  @koi/core   (L0)   KoiMiddleware, ModelRequest,           │
│                      ToolRequest, TurnContext,              │
│                      PermissionBackend, AuditEntry,         │
│                      AuditSink, ApprovalHandler             │
│  @koi/errors (L0u)  KoiRuntimeError, createCircuitBreaker, │
│                      swallowError                           │
│  @koi/hash   (L0u)  fnv1a for cache keys                   │
└────────────────────────────────────────────────────────────┘
```

---

## How It Works

### The Three Effects

Every tool the LLM wants to use gets one of three decisions:

| Effect | What happens | LLM sees the tool? |
|--------|-------------|---------------------|
| **allow** | Tool runs immediately | Yes |
| **deny** | Tool stripped from context | No — invisible |
| **ask** | Execution pauses, human prompted | Yes, but blocked until approved |

### Evaluation Order

Deny-first, then ask, then allow:

```
Tool ID arrives
    │
    ├── matches deny pattern?  ──yes──▶ DENY  (deny always wins)
    │
    ├── matches ask pattern?   ──yes──▶ ASK
    │
    ├── matches allow pattern? ──yes──▶ ALLOW
    │
    └── no match?
         ├── defaultDeny=true  ──────▶ DENY  (default)
         └── defaultDeny=false ──────▶ ALLOW
```

### Two Interception Points

The middleware hooks into both `wrapModelCall` and `wrapToolCall`:

```
                    User sends message
                           │
                           ▼
┌─ wrapModelCall ──────────────────────────────────────────┐
│                                                          │
│  LLM is about to see 5 tools. Check all 5 in batch:     │
│                                                          │
│  fs:read      → ALLOW  (kept)                            │
│  fs:write     → ASK    (kept — will gate later)          │
│  fetch        → ALLOW  (kept)                            │
│  bash         → DENY   (stripped — LLM never sees)       │
│  delete_file  → DENY   (stripped — LLM never sees)       │
│                                                          │
│  Filtered list → [fs:read, fs:write, fetch]              │
│  Each decision → audit log                               │
└──────────────────────────┬───────────────────────────────┘
                           │
                    LLM picks fs:write
                           │
                           ▼
┌─ wrapToolCall ───────────────────────────────────────────┐
│                                                          │
│  Re-check "fs:write" → ASK                               │
│                                                          │
│  ┌────────────────────────────────────────┐              │
│  │  ApprovalHandler.requestApproval()     │              │
│  │                                        │              │
│  │  "fs:write wants to create output.txt" │              │
│  │                                        │              │
│  │  [Approve]          [Deny]             │              │
│  └──────┬────────────────┬────────────────┘              │
│         │                │                               │
│    next(request)    throw PERMISSION                     │
│                                                          │
│  Timeout (30s default) → auto-deny                       │
│  Decision → audit log with durationMs                    │
└──────────────────────────────────────────────────────────┘
```

---

## Named Tool Groups

Instead of listing every tool individually, use `group:<name>` to match categories:

```typescript
import { createPatternPermissionBackend, DEFAULT_GROUPS } from "@koi/middleware-permissions";

const backend = createPatternPermissionBackend({
  rules: {
    allow: ["group:fs_read", "group:web"],  // safe categories
    deny:  ["group:runtime"],                // block shell access
    ask:   ["group:fs_write"],               // gate writes on human approval
  },
  groups: DEFAULT_GROUPS,
});
```

### Built-in Groups (DEFAULT_GROUPS)

| Group | Expands to | Use case |
|-------|-----------|----------|
| `fs` | `fs:*` | All filesystem operations |
| `fs_read` | `fs:read`, `fs:stat`, `fs:list`, `fs:glob` | Read-only filesystem |
| `fs_write` | `fs:write`, `fs:create`, `fs:mkdir` | Write operations |
| `fs_delete` | `fs:delete`, `fs:rm`, `fs:rmdir` | Destructive operations |
| `runtime` | `exec`, `spawn`, `bash`, `shell` | Shell execution |
| `web` | `http:*`, `fetch`, `curl` | Network calls |
| `browser` | `browser_*` | Playwright-style automation |
| `db` | `db:*` | All database operations |
| `db_read` | `db:query`, `db:read`, `db:select` | Read-only database |
| `db_write` | `db:write`, `db:insert`, `db:update`, `db:delete` | Database mutations |
| `lsp` | `lsp/*` | Language server tools |
| `mcp` | `mcp/*` | MCP server tools |

Extend with custom groups:

```typescript
const groups = {
  ...DEFAULT_GROUPS,
  deploy: ["deploy:staging", "deploy:production"],
  monitoring: ["metrics:*", "logs:*", "traces:*"],
};
```

---

## Decision Cache

Avoids redundant permission checks when the same tool is used repeatedly:

```
1st call: multiply
  cache MISS → backend.check() → ALLOW
  cache.set(key, { effect: "allow", expiresAt: now + 60s })

2nd call: multiply  (12ms later)
  cache HIT → return ALLOW  (backend never called)

Batch (wrapModelCall with 5 tools):
  ┌─────────┬─────────┬─────────┬─────────┬─────────┐
  │ tool A  │ tool B  │ tool C  │ tool D  │ tool E  │
  │ HIT     │ MISS    │ HIT     │ MISS    │ HIT     │
  └─────────┴────┬────┴─────────┴────┬────┴─────────┘
                 │                   │
                 ▼                   │
       backend.checkBatch([B, D]) ◄──┘  (only 2 calls, not 5)
```

- LRU eviction when `maxEntries` reached
- Per-effect TTL: `allowTtlMs` (default 300s), `denyTtlMs` (default 10s)
- `ask` decisions are **never cached** in the decision cache (require human interaction each time)

---

## Approval Cache

The approval cache is a separate mechanism from the decision cache. It stores human "ask" approvals so users don't get re-prompted for the same tool call.

### The Stale Authorization Problem

A naive cache keyed by `(toolId, input)` has security holes:

```
cache key = hash(toolId + input)

  Alice                 Bob
    |                     |
    +-- deploy(prod) -----+
    |   ask -> approve    |
    |   cached            |
    |                     +-- deploy(prod) ----+
    |                     |   CACHE HIT!       |
    |                     |   Bob rides Alice's|
    |                     |   approval         |

Problem 1: Bob uses Alice's cached approval (identity leak)
Problem 2: Approvals never expire (no time bound)
```

### Multi-Dimensional Cache Key

The fix includes multiple dimensions in the cache key:

```
cache key = fnv1a(backendFingerprint \0 userId \0 toolId \0 input)
                  ^^^^^^^^^^^^^^^^^^    ^^^^^^    ^^^^^^    ^^^^^
                  policy dimension      identity  tool      input
                                        dimension dimension dimension

+---------------------+-------------------------------------+
| Stale scenario      | Defense                             |
+---------------------+-------------------------------------+
| User switched       | Different userId -> cache miss      |
| Time passed         | TTL expired -> evict + re-prompt    |
+---------------------+-------------------------------------+
```

### TTL Behavior

**Backend fingerprint** — computed once at middleware construction from a stable random tag:

```
backendFingerprint = fnv1a(String(Math.random()))
```

Since the backend is opaque (pluggable via the `PermissionBackend` interface), the fingerprint uses object identity via a random tag. A new middleware instance with a different backend gets a different fingerprint.

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

**TTL** — checked on every cache hit. Uses the injected `clock` for deterministic testing:

```
expired = ttlMs > 0 && clock() - entry.cachedAt >= ttlMs
```

Default: 5 minutes (300,000ms). Set `ttlMs: 0` to disable expiry.

### LRU Eviction

The cache uses Map insertion-order as an LRU:

```
Cache (maxEntries: 256)

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

## Audit Trail

Every permission decision is logged to an `AuditSink` (fire-and-forget, never blocks the agent):

```
AuditSink receives:

{ timestamp: 1740...,
  sessionId: "s-1",
  agentId: "agent-coder",
  turnIndex: 3,
  kind: "tool_call",
  durationMs: 2,
  metadata: {
    permissionCheck: true,
    resource: "fs:write",
    effect: "ask",
    reason: "Tool \"fs:write\" requires approval"
  }
}
```

- Logs from both `wrapModelCall` (batch) and `wrapToolCall` (individual)
- `durationMs` measures actual backend latency (not hardcoded)
- Sink errors are swallowed — a broken logger never crashes the agent

### Two-Entry Audit Model for Approvals

When the permission backend returns `effect: "ask"`, two audit entries are emitted:

**Entry 1 — Permission check** (`phase: "execute"`):
Logged immediately after the backend responds, before the human is asked.
Contains the backend's decision (`effect: "ask"`) and reason.

**Entry 2 — Approval outcome** (`phase: "approval_outcome"`):
Logged after the human responds via the `ApprovalHandler`. Contains:

| Field | Description |
|-------|-------------|
| `approvalDecision` | `"allow"`, `"deny"`, `"modify"`, or `"always-allow"` |
| `userId` | Actor who made the decision (`ctx.session.userId` or `"__anonymous__"`) |
| `denyReason` | Reason string (deny only) |
| `originalInputKeys` | Sorted key names of agent's proposed input (modify only) |
| `modifiedInputKeys` | Sorted key names of human's rewritten input (modify only) |
| `inputModified` | `true` when input was rewritten (modify only) |
| `scope` | `"session"` (always-allow only) |

Both entries share `sessionId`, `agentId`, `turnIndex`, `kind: "tool_call"`, and
`permissionCheck: true`. The `userId` field is also included in Entry 1.

### Approval Trajectory Steps

Approval decisions are also emitted as `RichTrajectoryStep` entries with `source: "user"`
via the optional `onApprovalStep` callback. This makes the human's judgment visible in
ATIF trajectories alongside agent and tool steps. Each step carries:

- `source: "user"`, `kind: "tool_call"`
- `identifier`: the tool ID that was approved/denied
- `outcome`: `"success"` (allow/modify/always-allow) or `"failure"` (deny)
- `metadata`: same structured fields as the audit entry (decision, userId, delta)

---

## Circuit Breaker

Protects against external permission backend outages:

```
Normal:   backend.check() ──► success ──► recordSuccess()

Failure:  backend.check() ──► throws  ──► recordFailure()  (1/3)

3 failures in window:
          ┌──────────────────────┐
          │ CIRCUIT OPEN         │
          │ All checks → DENY    │
          │ "fail closed"        │
          └──────────┬───────────┘
                     │ cooldownMs elapsed
                     ▼
          ┌──────────────────────┐
          │ CIRCUIT HALF-OPEN    │
          │ Try backend again    │
          └──────────┬───────────┘
                     │ success
                     ▼
          ┌──────────────────────┐
          │ CIRCUIT CLOSED       │
          │ Normal operation     │
          └──────────────────────┘
```

Reuses `createCircuitBreaker` from `@koi/errors` (L0u). Accepts `clock` injection for deterministic testing.

---

## Denial Escalation

When the same tool is repeatedly denied within a session, the middleware can short-circuit to deny without re-querying the backend. This saves latency and prevents the model from repeatedly attempting tools that will always be denied.

```
Tool "bash" denied 3 times this session
    │
    ├── denialEscalation disabled? → query backend as normal
    │
    └── denialEscalation enabled?
         │
         └── tracker.getByTool("bash").length >= threshold?
              │
              ├── yes → instant DENY (backend skipped, "auto-denied" reason)
              │
              └── no  → query backend as normal
```

Disabled by default (backward-compatible). Enable via config:

```typescript
const middleware = createPermissionsMiddleware({
  backend,
  denialEscalation: true,              // threshold: 3 (default)
  // or:
  denialEscalation: { threshold: 5 },  // custom threshold
});
```

- Scope: per-tool, per-session (cleared on `onSessionEnd`)
- Applies to both `wrapToolCall` (execution) and `wrapModelCall` (filtering)
- Escalated denials are still recorded in the `DenialTracker` for observability
- Escalated denials bypass the decision cache (no cache key computation needed)

---

## Pluggable Backend

The `PermissionBackend` is an L0 interface — swap implementations without changing middleware code:

```
                   PermissionBackend (L0 interface)
                           │
          ┌────────────────┼────────────────┐
          │                │                │
    Pattern-based     HTTP Policy      Database
    (built-in)        Server           Lookup
    sync, in-proc     async, remote    async, remote
```

The built-in `createPatternPermissionBackend` is synchronous and in-process (zero latency). For remote backends, the cache and circuit breaker handle latency and resilience.

```typescript
// Minimal interface
interface PermissionBackend {
  readonly check: (query: PermissionQuery) => PermissionDecision | Promise<PermissionDecision>;
  readonly checkBatch?: (queries: readonly PermissionQuery[]) => ... ;
  readonly dispose?: () => Promise<void>;
}
```

---

## Middleware Position (Onion)

```
             Incoming Model Call
                    │
                    ▼
        ┌───────────────────────┐
        │  middleware-audit      │  priority: 450
        ├───────────────────────┤
        │  middleware-semantic-  │  priority: 420
        │  retry                │
        ├───────────────────────┤
     ┌──│  middleware-permissions│──┐  priority: 100
     │  │  (THIS)               │  │
     │  ├───────────────────────┤  │
     │  │  engine adapter       │  │
     │  │  → LLM API call       │  │
     │  └───────────┬───────────┘  │
     │        Tool Response        │
     │              │              │
     │   Re-check at wrapToolCall  │
     └──────────────┴──────────────┘
```

Priority 100 = runs close to the engine. Tool filtering happens before the LLM sees anything.

---

## API Reference

### Factory Functions

#### `createPermissionsMiddleware(config)`

Creates the middleware instance.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `config.backend` | `PermissionBackend` | **required** | Pluggable authorization backend |
| `config.approvalTimeoutMs` | `number` | `30000` | Timeout before auto-deny on ask |
| `config.cache` | `boolean \| PermissionCacheConfig` | `false` | Enable decision caching |
| `config.approvalCache` | `boolean \| ApprovalCacheConfig` | `false` | Enable approval caching |
| `config.clock` | `() => number` | `Date.now` | Inject clock for testing |
| `config.auditSink` | `AuditSink` | — | Structured decision logging |
| `config.circuitBreaker` | `CircuitBreakerConfig` | — | Resilience for remote backends |
| `config.denialEscalation` | `boolean \| DenialEscalationConfig` | `false` | Auto-deny after repeated denials |
| `config.description` | `string` | `"Permission checks enabled"` | Capability label |

**Returns:** `KoiMiddleware`

#### `createPatternPermissionBackend(config)`

Built-in pattern-matching backend (synchronous, in-process).

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `config.rules.allow` | `readonly string[]` | **required** | Patterns that grant access |
| `config.rules.deny` | `readonly string[]` | **required** | Patterns that block access |
| `config.rules.ask` | `readonly string[]` | **required** | Patterns that require approval |
| `config.defaultDeny` | `boolean` | `true` | Deny unmatched tools |
| `config.groups` | `Record<string, readonly string[]>` | `{}` | Named group expansions |

**Returns:** `PermissionBackend`

#### `createAutoApprovalHandler()`

Always approves. For testing and development only.

**Returns:** `ApprovalHandler` (L0 type — returns `ApprovalDecision`)

#### `createDenialTracker(maxEntries?)`

Creates a per-session denial accumulator for observability and diagnostics.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `maxEntries` | `number` | `1024` | Max denial records before oldest evicted |

**Returns:** `DenialTracker`

#### `validatePermissionsConfig(input)`

Runtime config validation. Returns `Result<PermissionsMiddlewareConfig, KoiError>`.

### Constants

#### `DEFAULT_GROUPS`

12 built-in tool group presets. Merge with custom groups via spread: `{ ...DEFAULT_GROUPS, custom: [...] }`.

#### `DEFAULT_CACHE_CONFIG`

Default decision cache settings: `{ maxEntries: 1024, allowTtlMs: 300_000, denyTtlMs: 10_000 }`.

#### `DEFAULT_APPROVAL_CACHE_MAX_ENTRIES`

`256` — max cached human approvals.

#### `DEFAULT_APPROVAL_CACHE_TTL_MS`

`300_000` — 5-minute TTL for cached approvals.

### Types

| Type | Description |
|------|-------------|
| `PermissionsMiddlewareConfig` | Full config for `createPermissionsMiddleware()` |
| `PermissionCacheConfig` | `{ maxEntries, allowTtlMs, denyTtlMs, ttlMs }` |
| `PatternBackendConfig` | Config for `createPatternPermissionBackend()` |
| `PermissionRules` | `{ allow, deny, ask }` pattern arrays |
| `ApprovalHandler` | L0 type: `(request: ApprovalRequest) => Promise<ApprovalDecision>` |
| `DenialRecord` | `{ toolId, reason, timestamp, principal, turnIndex }` |
| `DenialTracker` | `{ record, getAll, getByTool, count, clear }` |
| `ApprovalCacheConfig` | `{ ttlMs?, maxEntries? }` |
| `DenialEscalationConfig` | `{ threshold?, enabled? }` |
| `PermissionBackend` | L0 interface: `check()` + optional `checkBatch()` + `dispose()` |
| `PermissionDecision` | `{ effect: "allow" } \| { effect: "deny", reason } \| { effect: "ask", reason }` |
| `PermissionQuery` | `{ principal, action, resource, context? }` |

---

## Examples

### Basic: Allow-List Only

```typescript
import { createPatternPermissionBackend, createPermissionsMiddleware } from "@koi/middleware-permissions";

const middleware = createPermissionsMiddleware({
  backend: createPatternPermissionBackend({
    rules: {
      allow: ["multiply", "get_weather"],
      deny: [],
      ask: [],
    },
  }),
});

// Register in agent assembly:
const runtime = await createKoi({
  manifest,
  adapter,
  middleware: [middleware],
});
```

### With Groups, Cache, and Audit

```typescript
import {
  createPatternPermissionBackend,
  createPermissionsMiddleware,
  DEFAULT_GROUPS,
} from "@koi/middleware-permissions";

const entries = [];

const middleware = createPermissionsMiddleware({
  backend: createPatternPermissionBackend({
    rules: {
      allow: ["group:fs_read", "group:web"],
      deny: ["group:runtime"],
      ask: ["group:fs_write"],
    },
    groups: DEFAULT_GROUPS,
  }),
  cache: { maxEntries: 512, allowTtlMs: 120_000, denyTtlMs: 60_000 },
  auditSink: {
    log: async (entry) => {
      entries.push(entry);
    },
  },
  approvalHandler: {
    requestApproval: async (toolId, input, reason) => {
      console.log(`Approve ${toolId}? Reason: ${reason}`);
      return true; // or prompt user via UI
    },
  },
  approvalTimeoutMs: 60_000,
});
```

### With Circuit Breaker (Remote Backend)

```typescript
const middleware = createPermissionsMiddleware({
  backend: myHttpPolicyBackend,  // remote backend
  cache: true,                    // cache to reduce round-trips
  circuitBreaker: {
    failureThreshold: 5,          // open after 5 failures
    cooldownMs: 30_000,           // retry after 30s
    failureWindowMs: 60_000,      // failure window
    failureStatusCodes: [],
  },
});
```

### Deterministic Testing

```typescript
import { describe, expect, test } from "bun:test";

test("cache expires after TTL", async () => {
  let now = 1000;
  const middleware = createPermissionsMiddleware({
    backend: myBackend,
    cache: { maxEntries: 100, allowTtlMs: 5000, denyTtlMs: 2000 },
    clock: () => now,
  });

  // First call: cache miss → backend called
  // Second call: cache hit → backend skipped
  // Advance clock past TTL:
  now += 6000;
  // Third call: cache expired → backend called again
});
```

---

## Hot Path Performance

The middleware adds minimal overhead on the success path:

```
wrapModelCall:
  │
  ├── no tools? → straight through (zero cost)
  │
  └── has tools → checkBatch (cache-partitioned)
       ├── all cache hits → zero backend calls
       ├── some misses → only misses sent to backend
       └── audit: fire-and-forget (non-blocking)

wrapToolCall:
  │
  ├── cache hit? → return decision (no backend call)
  │
  ├── circuit open? → instant deny (no backend call)
  │
  └── cache miss → backend.check() → cache result
```

- Groups pre-expanded at construction (not per-check)
- FNV-1a cache keys: O(n) with zero allocations beyond the key string
- LRU cache bounded by `maxEntries` — no unbounded growth
- Audit sink errors swallowed — never blocks the hot path

---

## Layer Compliance

```
L0  @koi/core ──────────────────────────────────────────┐
    KoiMiddleware, ModelRequest, ToolRequest,             │
    TurnContext, PermissionBackend, PermissionDecision,    │
    PermissionQuery, AuditEntry, AuditSink                │
                                                           │
L0u @koi/errors ────────────────────────────────────┐     │
    KoiRuntimeError, createCircuitBreaker,           │     │
    swallowError                                     │     │
                                                     ▼     ▼
L2  @koi/middleware-permissions ◄─────────────────────┴─────┘
    imports from L0 + L0u only
    ✗ never imports @koi/engine (L1)
    ✗ never imports peer L2 packages
    ✗ zero external dependencies
```

**Dev-only dependencies** (`@koi/engine`, `@koi/engine-loop`, `@koi/engine-pi`, `@koi/test-utils`) are used in tests but are not runtime imports.

> **Maintenance note (PR #1506):** Added `biome-ignore lint/style/noNonNullAssertion` annotations with justification comments to bounds-checked index accesses in the batch permission resolver. The `uncachedIndices`/`validated` array indexing invariant (`j < both arrays' lengths`) is preserved; restructuring to remove `!` would break the length-check guard. No functional changes.
