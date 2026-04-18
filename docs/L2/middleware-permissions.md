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
| `lsp` | `lsp/*`, `lsp__*` | Language server tools (supports both `/` and `__` naming) |
| `mcp` | `mcp/*`, `mcp__*` | MCP server tools (supports both `/` and `__` naming) |

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

Approval decisions are emitted as `RichTrajectoryStep` entries with `source: "user"`
via `onApprovalStep` (config) and/or runtime-bound sinks (via `setApprovalStepSink`).
This makes the human's judgment visible in ATIF trajectories alongside agent and tool steps.

**Every approval code path emits a step:**

| Path | `approvalDecision` | `outcome` |
|------|-------------------|-----------|
| Explicit allow | `"allow"` | `"success"` |
| Explicit deny | `"deny"` | `"failure"` |
| Modify (input rewrite) | `"modify"` | `"success"` |
| Always-allow (session bypass) | `"always-allow"` | `"success"` |
| Approval cache hit | `"allow"` | `"success"` |
| Timeout | `"deny"` (reason: `"timeout"`) | `"failure"` |
| Malformed response | `"deny"` (reason: `"malformed_response"`) | `"failure"` |
| Handler error | `"deny"` (reason: `"handler_error"`) | `"failure"` |
| Coalesced (any of above) | same as leader | same, with `coalesced: true` |

Each step carries:

- `source: "user"`, `kind: "tool_call"`
- `identifier`: the tool ID that was approved/denied
- `outcome`: `"success"` or `"failure"` per table above
- `stepIndex`: assigned by `emitExternalStep` (monotonic session-local index)
- `metadata`: same structured fields as the audit entry (decision, userId, delta)

### MW Span Decision Metadata (ATIF Trace)

When wrapped by `wrapMiddlewareWithTrace` (L3 runtime), the permissions
middleware also emits structured decision metadata via `ctx.reportDecision`
on **every** tool permission check (security audit boundary — all decisions
matter, not just denies).

**Filter phase** (`filterTools` on `wrapModelCall` / `wrapModelStream`):
```typescript
{
  phase: "filter";
  totalTools: number;
  allowedCount: number;
  filteredCount: number;
  filteredTools: Array<{
    tool: string;
    reason: string;
    source: "policy" | "escalation" | "backend-error" | "approval";
  }>;
}
```
Only emitted when `filteredCount > 0` (filter that changed the tool list).

**Execute phase** (`wrapToolCall`):
```typescript
{
  phase: "execute";
  toolId: string;
  toolInput: string;          // JSON preview, truncated to 300 chars
  action: "allow" | "deny" | "ask";
  durationMs: number;
  reason?: string;            // Present when action !== "allow"
  source: "policy" | "escalation" | "backend-error" | "approval";
}
```

The decision appears in the ATIF trajectory as `metadata.decisions[]` on the
`middleware:permissions` span. This is distinct from the approval-trajectory
steps above — approval steps are standalone `source: "user"` steps for human
judgment, while MW decisions ride on the middleware span for the permission
check itself.

### Trajectory Visibility

Reports `{phase: "filter", totalTools, allowedCount, filteredCount}` via `ctx.reportDecision()` on `wrapModelCall` for all outcomes (including when all tools are allowed). Shows `[filter:N/N]` in the TUI trajectory view.

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
| `config.onApprovalStep` | `(sessionId: string, step: RichTrajectoryStep) => void` | — | Direct approval-step callback (unit tests) |

**Returns:** `PermissionsMiddlewareHandle` (extends `KoiMiddleware` — backward compatible, can be passed directly into `middleware: [...]` arrays)

The returned handle adds `setApprovalStepSink(sink)` for runtime wiring. The runtime calls this to register a dispatch relay that routes approval steps to per-stream `emitExternalStep`. Returns a disposer function for cleanup on `runtime.dispose()`. Multiple sinks can coexist (multi-runtime safe). Both `onApprovalStep` (config) and runtime sinks receive steps in fan-out with per-sink error isolation.

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
| `PermissionsMiddlewareHandle` | Return type of `createPermissionsMiddleware()` — extends `KoiMiddleware` + `setApprovalStepSink` |
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

## Session-Scoped Approval Cleanup

`PermissionsMiddlewareHandle` exposes `clearSessionApprovals(sessionId)` for external
callers (e.g. TUI runtime on `agent:clear` / `session:new`). Clears all session-scoped
state: always-allow grants, decision caches, approval caches, denial trackers, and
in-flight approval coalesce entries. Without this, prior-session approvals could
silently carry over into what the user expects to be a fresh conversation.

### In-Flight Approval Tracking

An internal `inflightKeysBySession` index maps each session to its set of in-flight
dedup keys. This allows `clearSessionApprovals` to evict pending approvals for a
session on reset, preventing a stale dialog resolution from re-populating the cache.

### Abort-Aware Approval Race

`handleAskDecision` now races the approval handler against `ctx.signal` (the turn/session
abort signal). If the turn is aborted (Ctrl+C / `agent:clear`) while a permission prompt
is pending, the approval is cancelled with a `PERMISSION` error instead of silently
winning and executing the tool in what the user believes is a fresh session.

> **Maintenance note (PR #1506):** Added `biome-ignore lint/style/noNonNullAssertion` annotations with justification comments to bounds-checked index accesses in the batch permission resolver. The `uncachedIndices`/`validated` array indexing invariant (`j < both arrays' lengths`) is preserved; restructuring to remove `!` would break the length-check guard. No functional changes.

---

## Persistent Approval Memory (#1622)

Cross-session "always" approval scope backed by SQLite. When a user grants `always-allow`
with scope `"always"`, the decision persists to a durable store and survives process restart.

### New exports

- `createApprovalStore(config)` — SQLite-backed persistent approval store
- `ApprovalStore` interface with `has`, `grant`, `revoke`, `revokeAll`, `list`, `close`
- `ApprovalGrant` type — `{ userId, agentId, toolId, grantedAt }`

### New config options

- `persistentApprovals?: ApprovalStore` — inject the store for cross-session grants
- `persistentAgentId?: string` — stable agent identifier for persistent grant keys
  (required for grants to survive restart, since `ctx.session.agentId` is a random UUID)

### Lookup cascade (updated)

1. **Persistent store (SQLite)** — `has(userId, persistentAgentId, toolId)`, fail-open on error
2. Session always-allow set (in-memory, existing behavior)
3. Approval cache (TTL, existing behavior)
4. Prompt user

### Security invariants

- Anonymous sessions (`userId === undefined`) cannot create or replay persistent grants
- Grant key includes `userId` to prevent cross-user inheritance
- Schema version field (`schema_version`) lets apps invalidate stale grants on policy changes
- No destructive startup pruning — lookups filter by version for rollback safety
- Fail-open on store errors (corrupt/locked DB → fall through to prompt, not silent deny)
- Fail-safe on persist errors (tool executes after user approval, permanence just not recorded)

### New handle methods

- `revokePersistentApproval(userId, agentId, toolId)` — revoke a specific grant
- `revokeAllPersistentApprovals()` — revoke all grants
- `listPersistentApprovals()` — list all grants (for UI/diagnostics)

### Audit events

New `metadata.permissionEvent` field on audit entries:
- `"asked"` — backend returned `ask`, prompting user
- `"granted"` — user allowed the tool call
- `"denied"` — user denied the tool call
- `"remembered"` — persistent or session grant matched (fast-path replay)

See `docs/L2/security-permissions.md` for the end-to-end flow and TUI integration details.

---

## `onPermissionDecision` Hook Dispatch (#1627)

`wrapToolCall` now fires the L0 `KoiMiddleware.onPermissionDecision` hook for every `ask`-path outcome by passing a `dispatchApprovalOutcome` callback into `handleAskDecision`.

**Key property: fires BEFORE `next(request)`** — the permission record is written before tool execution starts. This means:
- A tool that throws after approval still has a `permission_decision` record
- The audit trail is accurate regardless of downstream failures
- Observers (e.g., `@koi/middleware-audit`) receive the decision synchronously on the same tick

The callback pattern avoids L2→L2 imports — `wrapToolCall` passes a closure that calls `ctx.dispatchPermissionDecision?.(query, decision)`, which the L1 engine routes to all registered middleware hooks without this package knowing about `@koi/middleware-audit`:

```typescript
// wrapToolCall (simplified)
if (decision.effect === "ask") {
  return handleAskDecision(ctx, request, next, decision, (d) => {
    void ctx.dispatchPermissionDecision?.(query, d);
  });
}
```

**Coverage:** persistent always-allow, session always-allow, cache hit, coalesced inflight allow, fresh approval (allow/modify/always-allow), and all deny paths.

---

## UI-only `callId` channel (#1759)

Per-invocation UI/observability identifiers travel on a **dedicated `ToolRequest.callId` field** (set by `@koi/query-engine`'s turn-runner) and are explicitly NOT part of `request.metadata`. Rationale:

- **Backend policy query symmetry.** Custom backends still see `request.metadata` unchanged in `queryForTool(…)`. `callId` never enters the `_request` merge block, so backends cannot accidentally vary decisions on a value that is unique per invocation and thus unstable across retries.
- **Approval cache + in-flight dedup coalescing.** `computeApprovalCacheKey(…)` uses `request.metadata` directly — no stripping needed — so two identical asks with distinct `callId`s still share one cache/dedup identity.
- **Forwarded to the approval handler.** `handleAskDecision(…)` forwards `request.callId` onto the `ApprovalRequest` via a matching dedicated field (not metadata). The TUI permission bridge reads it directly to dispatch a per-call timer reset on approval.

If `metadata.callId` were allowed to leak into policy-visible surfaces, either (a) repeated identical asks would no longer coalesce, or (b) backends that varied on `_request.callId` could be defeated by the cache. Keeping the UI identifier on its own channel avoids both failure modes.

## Interactive approval timeout (#1759)

`DEFAULT_APPROVAL_TIMEOUT_MS = 30_000` remains the engine-side fail-closed deadline for agent-to-agent / non-interactive callers. The interactive TUI opts into a longer 60-minute window by passing `approvalTimeoutMs: 60 * 60 * 1000` (see `@koi/tui` + `packages/meta/cli/src/tui-runtime.ts`). Long enough that no realistic human decision window triggers it, but still finite so a wedged renderer / stuck bridge eventually aborts the turn rather than hanging forever. `Number.POSITIVE_INFINITY` is accepted by `validatePermissionsConfig` for tests that need truly unbounded waits.

---

## Soft Deny — Recoverable Denials (#1650)

The `PermissionDecision` type now includes an optional `disposition` field on deny outcomes. Rules may opt into soft-deny by setting `on_deny: "soft"` — the middleware returns a synthetic `ToolResponse` instead of throwing, allowing the agent to adapt.

### `disposition` Field on Deny Decisions

When `decision.effect === "deny"`:

```typescript
// Hard (default, pre-#1650 behavior)
{ effect: "deny", reason: "...", disposition: "hard" }

// Soft (opt-in, returns synthetic response to agent)
{ effect: "deny", reason: "...", disposition: "soft" }

// Pre-#1650 records have no disposition field (treat as "hard")
{ effect: "deny", reason: "..." }  // disposition absent
```

The `disposition` field is **only present on deny outcomes**. Allow and ask decisions never have it.

### Audit Trail and Denial Records

`AuditEntry` schema **remains unchanged** — no new top-level fields. The disposition is visible in the audit metadata only when relevant.

The `DenialRecord` type (for observability) gains two optional fields:

```typescript
interface DenialRecord {
  readonly toolId: string;
  readonly reason: string;
  readonly timestamp: number;
  readonly principal: string;
  readonly turnIndex: number;
  readonly source: DenialSource;
  readonly queryKey?: string;

  // New in #1650:
  readonly softness?: "soft" | "hard" | undefined;
  readonly origin?: "native" | "soft-conversion" | undefined;
}
```

**`softness`** — the disposition of the deny:
- `"soft"` — opted into soft-deny via `on_deny: "soft"`
- `"hard"` — native hard deny or promoted from soft (when cap exceeded)
- Absent — pre-#1650 records still in memory (treat as `"hard"`)

**`origin`** — where the record came from:
- `"native"` — produced by the rule evaluator, user approval denial, fail-closed, or pre-existing escalation
- `"soft-conversion"` — promoted from soft to hard when exceeding per-turn cap or unkeyable fail-closed
- Absent — pre-#1650 records

### Soft-Deny Log vs. Denial Tracker

Soft-deny events are recorded in two separate structures:

**`SoftDenyLog`** (internal, NOT exported):
- Per-session append-only log of soft-deny events
- Bounded by a 1024-entry FIFO (same size as `DenialTracker`)
- Not exposed via public API
- Used only for observability and debug views within the package

**`DenialTracker`** (public, existing):
- Records **hard denies only** (including promoted soft→hard)
- Backs Mechanism A's session-wide escalation prefilter
- Queryable via `getAll()`, `getByTool()`, etc.
- Cleared on session end

Keeping soft-deny events isolated prevents high-volume recoverable probes from evicting hard-deny history that escalation depends on.

### Mechanism A Prefilter Exclusion

The session-wide escalation prefilter (Mechanism A, existing feature) now **explicitly excludes** denial records where:

```typescript
record.origin === "soft-conversion" || record.softness === "soft"
```

This prevents per-turn soft-deny cap events from feeding into session-wide escalation thresholds. A tool that is soft-denied repeatedly within a turn (but under the cap) will not trigger automatic session-wide hard-blocking.

### Cross-Tool Rotation Edge Case

When the agent rotates between multiple tools all hitting the same soft-deny rule, each tool's cache key maintains its own per-turn counter. If many tools probe the same underlying resource, the combined soft-deny volume can exceed the per-turn cap × tool count before hitting the engine's max-iterations limit.

**This is a known limitation.** Classifier-driven query normalization (filed separately, not yet implemented) will address this by coalescing repeated probes on the same resource into a single cache key, closing the gap at the policy level.

---

## Changelog

- **Path-aware filesystem permissions** — fs_read for out-of-workspace paths triggers permission prompt instead of silent NOT_FOUND.
