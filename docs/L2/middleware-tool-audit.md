# @koi/middleware-tool-audit — Tool Usage Tracking and Lifecycle Signals

Silently observes every tool call and model request, accumulates usage statistics across sessions, and emits lifecycle signals that identify which tools are high-value, failing, underused, or dead. Zero LLM involvement — pure bookkeeping and arithmetic.

---

## Why It Exists

Claude Code maintains ~20 tools and "constantly asks if we need all of them." As model capabilities improve, tools once essential become constraining or unused. Without usage tracking, dead tools accumulate and increase cognitive load.

This middleware solves three problems:

1. **No visibility into tool health** — without tracking, you can't distinguish a tool that's called 200 times per session from one that's never been called across 50 sessions
2. **No data-driven pruning** — removing a tool is a gut call. With cumulative statistics, you can see adoption rates, failure rates, and latency trends
3. **No lifecycle awareness** — tools follow a lifecycle (introduced → adopted → high-value → declining → dead). Without signals, you can't detect where each tool sits

This is the inverse of tool crystallization (#109 — creating tools from patterns). Audit *prunes* the tools that crystallization creates.

---

## Architecture

`@koi/middleware-tool-audit` is an **L2 feature package** — it depends only on L0 (`@koi/core`) and L0u (`@koi/resolve`). Zero external dependencies.

```
┌────────────────────────────────────────────────────────┐
│  @koi/middleware-tool-audit  (L2)                       │
│                                                        │
│  types.ts             ← 6 domain types                 │
│  config.ts            ← config interface + validation  │
│  signals.ts           ← pure lifecycle signal analysis │
│  tool-audit.ts        ← middleware factory + state     │
│  descriptor.ts        ← BrickDescriptor for manifest   │
│  index.ts             ← public API surface             │
│                                                        │
├────────────────────────────────────────────────────────┤
│  Dependencies                                          │
│                                                        │
│  @koi/core    (L0)   KoiMiddleware, ModelRequest,      │
│                       ModelResponse, ToolRequest,       │
│                       ToolResponse, SessionContext,     │
│                       TurnContext, CapabilityFragment   │
│  @koi/resolve (L0u)  BrickDescriptor                   │
└────────────────────────────────────────────────────────┘
```

---

## How It Works

### No LLM — Pure Observation

The middleware adds zero intelligence. It counts, divides, and compares thresholds:

```
wrapModelCall  →  reads request.tools array  →  records which tools were OFFERED
wrapToolCall   →  times the call             →  records success/failure + latency
onSessionEnd   →  flushes per-session sets   →  computes signals, saves snapshot
```

### Data Flow

```
Session 1              Session 2              Session N
┌──────────────┐       ┌──────────────┐       ┌──────────────┐
│ Model request│       │ Model request│       │ Model request│
│ tools: [     │       │ tools: [     │       │ tools: [     │
│  search      │       │  search      │       │  search      │
│  read        │       │  read        │       │  read        │
│  write       │       │  write       │       │  write       │
│  deploy      │       │  deploy      │       │  deploy      │
│ ]            │       │ ]            │       │ ]            │
└──────┬───────┘       └──────┬───────┘       └──────┬───────┘
       │                      │                      │
       ▼                      ▼                      ▼
 Agent calls:           Agent calls:           Agent calls:
 ✓ search (42ms)        ✓ search (38ms)        ✓ search (40ms)
 ✓ read   (12ms)        ✗ write  (err!)        ✓ read   (11ms)
 · write  (unused)      · deploy (unused)      · deploy (unused)
 · deploy (unused)
       │                      │                      │
       └──────────┬───────────┘──────────────────────┘
                  ▼
┌─────────────────────────────────────────────────────────┐
│  Accumulated Snapshot (persisted via ToolAuditStore)     │
│                                                         │
│  search ─── calls: 87  success: 87  fail: 0            │
│             latency: avg 39ms  min 28ms  max 55ms       │
│             available: 50 sessions  used: 50 sessions   │
│                                                         │
│  read ───── calls: 62  success: 62  fail: 0            │
│             available: 50 sessions  used: 48 sessions   │
│                                                         │
│  write ──── calls: 8   success: 3   fail: 5            │
│             available: 50 sessions  used: 4 sessions    │
│                                                         │
│  deploy ─── calls: 0   success: 0   fail: 0            │
│             available: 50 sessions  used: 0 sessions    │
└─────────────────────────────────────────────────────────┘
                  │
                  ▼
┌─────────────────────────────────────────────────────────┐
│  Lifecycle Signals                                      │
│                                                         │
│  search ──── HIGH_VALUE   "succeeds 100% (87/87)"      │
│  read ────── HIGH_VALUE   "succeeds 100% (62/62)"      │
│  write ───── HIGH_FAILURE "fails 62.5% (5/8)"          │
│         ──── LOW_ADOPTION "used in 8% of sessions"     │
│  deploy ──── UNUSED       "never called across 50"     │
└─────────────────────────────────────────────────────────┘
```

### Middleware Hooks

```
┌──────────────────────────────────────────────────────────────┐
│  onSessionStart(ctx)                                         │
│                                                              │
│  1. Lazy load from store (concurrent calls share promise)    │
│  2. Hydrate tools Map from snapshot (first time only)        │
│  3. Increment totalSessions                                  │
│  4. Clear per-session sets (available + used)                │
│  5. Reset dirty flag                                         │
└──────────────────────────────────────────────────────────────┘
                           │
                           ▼
┌──────────────────────────────────────────────────────────────┐
│  wrapModelCall(ctx, request, next)                           │
│                                                              │
│  if request.tools defined:                                   │
│    for each tool → sessionAvailableTools.add(tool.name)      │
│    dirty = true                                              │
│                                                              │
│  return next(request)  ← transparent pass-through            │
└──────────────────────────────────────────────────────────────┘
                           │
                           ▼
┌──────────────────────────────────────────────────────────────┐
│  wrapToolCall(ctx, request, next)                            │
│                                                              │
│  record.callCount += 1                                       │
│  sessionUsedTools.add(toolId)                                │
│  dirty = true                                                │
│                                                              │
│  start = clock()                                             │
│  try:                                                        │
│    response = await next(request)                            │
│    latency = clock() - start                                 │
│    record.successCount += 1                                  │
│    update latency stats (sum / min / max)                    │
│  catch:                                                      │
│    latency = clock() - start                                 │
│    record.failureCount += 1                                  │
│    update latency stats                                      │
│    re-throw  ← never swallows errors                         │
└──────────────────────────────────────────────────────────────┘
                           │
                           ▼
┌──────────────────────────────────────────────────────────────┐
│  onSessionEnd(ctx)                                           │
│                                                              │
│  for each available tool → sessionsAvailable += 1            │
│  for each used tool     → sessionsUsed += 1                  │
│                                                              │
│  if dirty:                                                   │
│    1. Build snapshot from current tools Map                   │
│    2. Compute lifecycle signals (pure function)              │
│    3. Fire onAuditResult callback (if signals exist)         │
│    4. Save snapshot to store                                  │
│                                                              │
│  if not dirty: skip save entirely                            │
└──────────────────────────────────────────────────────────────┘
```

---

## 4 Lifecycle Signals

Each tool can emit one or more signals simultaneously (e.g., high failure AND low adoption):

| Signal | Condition | What It Means |
|--------|-----------|---------------|
| `unused` | `callCount === 0 && sessionsAvailable >= 50` | Tool has been offered to the LLM for 50+ sessions but never called. Candidate for removal. |
| `low_adoption` | `sessionsUsed / sessionsAvailable < 5%` with `sessionsAvailable >= 10` | Tool is available but agents rarely pick it. May have a discoverability problem or be redundant. |
| `high_failure` | `failureCount / callCount > 50%` with `callCount >= 5` | Tool is called but fails more than half the time. Needs fixing or better validation. |
| `high_value` | `successCount / callCount >= 90%` with `callCount >= 20` | Tool is heavily used with high success rate. Invest in and protect this tool. |

### Confidence Scoring

Signals include a confidence score (0–1) that scales with sample size:

```
confidence = min(1, sampleSize / (threshold × 2))
```

Examples:
- `unused` with 25 sessions available (threshold 50): `min(1, 25/100) = 0.25`
- `unused` with 100 sessions available: `min(1, 100/100) = 1.0`
- `high_failure` with 3 calls (threshold 5): below minimum, no signal emitted

All thresholds are configurable. Minimum sample sizes prevent signals from firing on insufficient data.

---

## Persistence (ToolAuditStore)

The store is optional — when omitted, an in-memory fallback tracks stats for the current process lifetime.

```
┌──────────────────────────────────────────────────────────┐
│  ToolAuditStore                                          │
│                                                          │
│  load() → ToolAuditSnapshot | Promise<ToolAuditSnapshot> │
│  save(snapshot) → void | Promise<void>                   │
│                                                          │
│  Implementations:                                        │
│  ├── In-memory (default fallback)                        │
│  ├── File-based (JSON on disk)                           │
│  ├── SQLite                                              │
│  └── Any async backend (database, API, etc.)             │
└──────────────────────────────────────────────────────────┘
```

### Snapshot Format

```typescript
{
  tools: {
    "search": {
      toolName: "search",
      callCount: 87,
      successCount: 87,
      failureCount: 0,
      lastUsedAt: 1740000000000,
      avgLatencyMs: 39,
      minLatencyMs: 28,
      maxLatencyMs: 55,
      totalLatencyMs: 3393,
      sessionsAvailable: 50,
      sessionsUsed: 50,
    },
    // ... more tools
  },
  totalSessions: 50,
  lastUpdatedAt: 1740000000000,
}
```

### Save Strategy

A **dirty flag** prevents unnecessary writes:

```
dirty = false at session start

wrapModelCall with tools present  →  dirty = true
wrapToolCall (any call)           →  dirty = true

onSessionEnd:
  dirty = true  →  save snapshot to store
  dirty = false →  skip save (no tool activity this session)
```

---

## Middleware Position (Onion)

Priority 100 = outermost layer. Sees all tool call attempts before any other middleware processes them.

```
              Incoming Model/Tool Call
                       │
                       ▼
          ┌───────────────────────┐
       ┌──│  middleware-tool-audit│──┐  priority: 100 (THIS)
       │  │  (observes + counts) │  │
       │  ├───────────────────────┤  │
       │  │  middleware-permissions│  │  priority: 100
       │  ├───────────────────────┤  │
       │  │  middleware-semantic-  │  │  priority: 420
       │  │  retry                │  │
       │  ├───────────────────────┤  │
       │  │  middleware-audit      │  │  priority: 450
       │  ├───────────────────────┤  │
       │  │  engine adapter       │  │
       │  │  → LLM API call       │  │
       │  └───────────┬───────────┘  │
       │        Response or Error    │
       │              │              │
       └──────────────┴──────────────┘
       tool-audit sees the final result
       (success, failure, latency)
```

---

## API Reference

### Factory Functions

#### `createToolAuditMiddleware(config)`

Creates the middleware with usage tracking, signal computation, and optional persistence.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `config.store` | `ToolAuditStore` | In-memory fallback | External persistence backend |
| `config.unusedThresholdSessions` | `number` | `50` | Sessions before "unused" signal fires |
| `config.lowAdoptionThreshold` | `number` | `0.05` | Adoption rate below which "low_adoption" fires (5%) |
| `config.highFailureThreshold` | `number` | `0.5` | Failure rate above which "high_failure" fires (50%) |
| `config.highValueSuccessThreshold` | `number` | `0.9` | Success rate above which "high_value" fires (90%) |
| `config.highValueMinCalls` | `number` | `20` | Minimum calls before "high_value" can fire |
| `config.minCallsForFailure` | `number` | `5` | Minimum calls before "high_failure" can fire |
| `config.minSessionsForAdoption` | `number` | `10` | Minimum sessions before "low_adoption" can fire |
| `config.onAuditResult` | `(results: readonly ToolAuditResult[]) => void` | — | Callback fired on session end with lifecycle signals |
| `config.onError` | `(error: unknown) => void` | — | Callback for store load/save errors |
| `config.clock` | `() => number` | `Date.now` | Inject clock for deterministic testing |

**Returns:** `ToolAuditMiddleware`

```typescript
interface ToolAuditMiddleware extends KoiMiddleware {
  readonly generateReport: () => readonly ToolAuditResult[]  // On-demand signals
  readonly getSnapshot: () => ToolAuditSnapshot               // Current state
}
```

#### `computeLifecycleSignals(snapshot, config)`

Pure function — computes lifecycle signals from a snapshot without side effects. Used internally by the middleware and available for standalone analysis.

| Parameter | Type | Description |
|-----------|------|-------------|
| `snapshot` | `ToolAuditSnapshot` | Accumulated tool usage data |
| `config` | `ToolAuditConfig` | Thresholds for signal computation |

**Returns:** `readonly ToolAuditResult[]`

#### `validateToolAuditConfig(config)`

Runtime config validation. Returns `Result<ToolAuditConfig, KoiError>`.

### Interfaces

#### `ToolAuditStore`

```typescript
interface ToolAuditStore {
  readonly load: () => ToolAuditSnapshot | Promise<ToolAuditSnapshot>
  readonly save: (snapshot: ToolAuditSnapshot) => void | Promise<void>
}
```

Sync implementations (in-memory, file) and async implementations (database, API) both satisfy this interface.

#### `ToolAuditSnapshot`

```typescript
interface ToolAuditSnapshot {
  readonly tools: Readonly<Record<string, ToolUsageRecord>>
  readonly totalSessions: number
  readonly lastUpdatedAt: number
}
```

#### `ToolUsageRecord`

```typescript
interface ToolUsageRecord {
  readonly toolName: string
  readonly callCount: number
  readonly successCount: number
  readonly failureCount: number
  readonly lastUsedAt: number
  readonly avgLatencyMs: number
  readonly minLatencyMs: number
  readonly maxLatencyMs: number
  readonly totalLatencyMs: number
  readonly sessionsAvailable: number
  readonly sessionsUsed: number
}
```

### Types

| Type | Description |
|------|-------------|
| `ToolAuditConfig` | Full config for `createToolAuditMiddleware()` |
| `ToolAuditMiddleware` | Extended `KoiMiddleware` with `generateReport()` + `getSnapshot()` |
| `ToolAuditSnapshot` | Serializable state — safe to persist to disk/DB |
| `ToolAuditStore` | External persistence: `load()` + `save()` |
| `ToolUsageRecord` | Per-tool cumulative stats (calls, latency, adoption) |
| `ToolAuditResult` | Signal output: `{ toolName, signal, confidence, details, record }` |
| `ToolLifecycleSignal` | `"unused" \| "low_adoption" \| "high_failure" \| "high_value"` |

---

## Examples

### Basic Usage

```typescript
import { createToolAuditMiddleware } from "@koi/middleware-tool-audit";

const auditMiddleware = createToolAuditMiddleware({});

const runtime = await createKoi({
  manifest,
  adapter,
  middleware: [auditMiddleware],
});

// After some sessions, check the data:
const snapshot = auditMiddleware.getSnapshot();
console.log(snapshot.tools.search?.callCount);     // 87
console.log(snapshot.tools.search?.avgLatencyMs);   // 39
```

### With Lifecycle Signal Callback

```typescript
const auditMiddleware = createToolAuditMiddleware({
  onAuditResult(signals) {
    for (const signal of signals) {
      console.log(`[audit] ${signal.toolName}: ${signal.signal} (${signal.confidence})`);
      // [audit] deploy: unused (0.5)
      // [audit] write: high_failure (0.8)
    }
  },
});
```

### With Persistent Store

```typescript
import { readFileSync, writeFileSync } from "node:fs";

const auditMiddleware = createToolAuditMiddleware({
  store: {
    load() {
      try {
        return JSON.parse(readFileSync(".tool-audit.json", "utf-8"));
      } catch {
        return { tools: {}, totalSessions: 0, lastUpdatedAt: 0 };
      }
    },
    save(snapshot) {
      writeFileSync(".tool-audit.json", JSON.stringify(snapshot, null, 2));
    },
  },
  onError(error) {
    console.error("[tool-audit] Store error:", error);
  },
});
```

### On-Demand Report

```typescript
// Generate signals at any point — not just session end
const signals = auditMiddleware.generateReport();

const unused = signals.filter((s) => s.signal === "unused");
const failing = signals.filter((s) => s.signal === "high_failure");

console.log(`${unused.length} unused tools, ${failing.length} failing tools`);
```

### With Other Middleware

```typescript
import { createToolAuditMiddleware } from "@koi/middleware-tool-audit";
import { createCallLimitsMiddleware } from "@koi/middleware-call-limits";
import { createPermissionsMiddleware } from "@koi/middleware-permissions";

const runtime = await createKoi({
  manifest,
  adapter,
  middleware: [
    createToolAuditMiddleware({ ... }),      // priority: 100 (outermost)
    createPermissionsMiddleware({ ... }),     // priority: 100
    createCallLimitsMiddleware({ ... }),      // priority: 200
  ],
});
```

### Deterministic Testing

```typescript
import { describe, expect, test } from "bun:test";
import { createToolAuditMiddleware } from "@koi/middleware-tool-audit";

test("tracks latency accurately", async () => {
  let time = 1000;
  const mw = createToolAuditMiddleware({
    clock: () => time,
    highValueMinCalls: 1,
    highValueSuccessThreshold: 0.9,
  });

  // ... setup session, then:
  const next = async () => {
    time += 42; // simulate 42ms latency
    return { output: "ok" };
  };

  await mw.wrapToolCall!(ctx, { toolId: "search", input: {} }, next);

  const snapshot = mw.getSnapshot();
  expect(snapshot.tools.search?.avgLatencyMs).toBe(42);
});
```

---

## Hot Path Performance

The middleware adds near-zero overhead on every call:

```
wrapModelCall:
  │
  ├── no tools in request? → straight through (zero cost)
  │
  └── has tools → iterate tool names, add to Set
       Cost: O(n) Set.add() calls, n = number of tools

wrapToolCall:
  │
  ├── getOrCreateRecord()   ← Map.get() + Map.set() on miss
  ├── clock()               ← 1 call before, 1 call after
  ├── 3 counter increments  ← integer addition
  └── 2 Math.min/max        ← comparison

onSessionEnd:
  │
  ├── dirty = false? → return immediately (zero cost)
  │
  └── dirty = true → iterate tools Map + compute signals
       Cost: O(t) where t = unique tools (typically < 30)
```

**Success path:** ~100ns overhead — Map lookup, 2 clock reads, 5 counter updates.

**Memory:** Counters per unique tool + 2 per-session `Set<string>` (cleared on session end). No unbounded growth — bounded by number of unique tool names.

---

## Layer Compliance

```
L0  @koi/core ────────────────────────────────────────────┐
    KoiMiddleware, ModelRequest, ModelResponse,            │
    ToolRequest, ToolResponse, SessionContext,             │
    TurnContext, CapabilityFragment                        │
                                                           │
L0u @koi/resolve ──────────────────────────────────┐      │
    BrickDescriptor                                 │      │
                                                    ▼      ▼
L2  @koi/middleware-tool-audit ◄────────────────────┴──────┘
    imports from L0 + L0u only
    ✗ never imports @koi/engine (L1)
    ✗ never imports peer L2 packages
    ✗ zero external dependencies
```

**Dev-only dependency** (`@koi/test-utils`) is used in tests but is not a runtime import.
