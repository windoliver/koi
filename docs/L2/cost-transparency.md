# Cost Transparency — Per-Session, Per-Tool, Per-Model

Granular cost tracking across the Koi stack. Canonical types live in `@koi/core/cost-tracker` (L0), implementations in `@koi/middleware-pay` (L2), Nexus adapter in `@koi/pay-nexus` (L2), and OTel span enrichment in `@koi/tracing` (L2).

---

## Why It Exists

Before this feature, cost data was a single per-session total. Operators couldn't answer:

- "Which model is eating the budget?"
- "How much does tool X cost per session?"
- "Can I see cost in my OTel dashboard?"

This feature promotes cost types to L0, adds breakdown queries, enriches tracing spans, and fixes a per-session alert bug.

---

## Architecture

### Layer Map

```
L0   @koi/core/cost-tracker   ─ CostEntry, CostBreakdown, BudgetTracker, UsageInfo, ...
L0   @koi/core/engine          ─ EngineMetrics.costUsd (optional)
L0   @koi/core/run-report      ─ ActionEntry.costUsd (optional)
L2   @koi/middleware-pay        ─ InMemoryBudgetTracker (pre-aggregated), PayMiddleware
L2   @koi/pay-nexus            ─ NexusBudgetTracker (ledger-backed)
L2   @koi/tracing              ─ koi.cost.usd span attribute via costEnricher
```

### Data Flow

```
  Model Call / Stream           @koi/middleware-pay                @koi/tracing
 ┌─────────────────┐          ┌───────────────────┐             ┌──────────────┐
 │ wrapModelCall    │──usage──▶│ recordCost()       │             │ wrapModelCall│
 │ wrapModelStream  │          │  ├ calculate cost   │             │  ├ if costEnricher:
 │                  │          │  ├ tracker.record()  │             │  │  costUsd = enricher()
 │                  │          │  ├ update aggregates │             │  │  span.set(KOI_COST_USD)
 │                  │          │  ├ fire alerts       │             │  └ error-isolated
 │                  │          │  └ if onUsage:       │             └──────────────┘
 │                  │          │     breakdown() ──┐  │
 └─────────────────┘          │     onUsage(info)◄─┘  │
                               └───────────────────┘
```

---

## L0 Contracts (`@koi/core/cost-tracker`)

Types-only module. Zero imports. Zero runtime code.

### `CostEntry`

A single cost event recorded during a model call.

| Field | Type | Description |
|-------|------|-------------|
| `inputTokens` | `number` | Input token count |
| `outputTokens` | `number` | Output token count |
| `model` | `string` | Model identifier |
| `costUsd` | `number` | Calculated USD cost |
| `timestamp` | `number` | Unix timestamp |
| `toolName?` | `string` | Optional tool attribution |

### `CostBreakdown`

Full session breakdown — total + per-model + per-tool.

```typescript
interface CostBreakdown {
  readonly totalCostUsd: number;
  readonly byModel: readonly ModelCostBreakdown[];
  readonly byTool: readonly ToolCostBreakdown[];
}
```

### `BudgetTracker`

Session-scoped budget tracker with breakdown queries. All methods return `T | Promise<T>`.

| Method | Signature | Description |
|--------|-----------|-------------|
| `record` | `(sessionId, entry) → void \| Promise<void>` | Record a cost event |
| `totalSpend` | `(sessionId) → number \| Promise<number>` | Total spend for session |
| `remaining` | `(sessionId, budget) → number \| Promise<number>` | Remaining budget |
| `breakdown` | `(sessionId) → CostBreakdown \| Promise<CostBreakdown>` | Per-model/tool breakdown |

### `UsageInfo`

Enriched usage information passed to `onUsage` callbacks.

| Field | Type | Description |
|-------|------|-------------|
| `entry` | `CostEntry` | The cost event that triggered this |
| `totalSpent` | `number` | Cumulative spend for the session |
| `remaining` | `number` | Budget remaining |
| `breakdown` | `CostBreakdown` | Full per-model/tool breakdown |

---

## `@koi/middleware-pay` Implementation

### Pre-Aggregated In-Memory Tracker

The `createInMemoryBudgetTracker()` maintains running aggregates on each `record()` call:

```
record()  ──▶  update totalCostUsd (running sum)
               update byModel Map<model, ModelCostBreakdown>
               update byTool Map<toolName, ToolCostBreakdown>

totalSpend()  ──▶  O(1) return agg.totalCostUsd
remaining()   ──▶  O(1) return max(0, budget - totalCostUsd)
breakdown()   ──▶  O(models + tools) freeze maps to readonly arrays
```

No iteration over raw entries for `totalSpend` or `remaining`. `breakdown()` only materializes frozen arrays when called (guarded behind `onUsage` check).

### `recordCost()` Helper

DRY helper shared by `wrapModelCall` and `wrapModelStream`:

1. Calculate cost via `calculator.calculate()`
2. Build `CostEntry` (with optional `toolName`)
3. `await tracker.record(sessionId, entry)`
4. Parallel fetch: `Promise.all([totalSpend, remaining])`
5. Update `lastKnownRemaining`
6. Fire threshold alerts (per-session)
7. If `onUsage` is set: fetch `breakdown()` and call callback

### Per-Session Alert Thresholds

Fixed bug: alerts were shared across sessions (single `Set<number>`). Now each session has its own `Set` via `Map<string, Set<number>>`. Cleaned up on `onSessionEnd`.

### `onBeforeTurn` Budget Refresh

The `describeCapabilities` hook shows remaining budget. Previously stale after model calls in other sessions. Now `onBeforeTurn` queries the tracker and updates `lastKnownRemaining`.

---

## `@koi/pay-nexus` Adapter

The `mapPayLedgerToBudgetTracker()` now includes `breakdown()`:

```typescript
async breakdown(_sessionId: string): Promise<CostBreakdown> {
  const balance = await ledger.getBalance();
  return {
    totalCostUsd: Math.max(0, budget - parseFloat(balance.available)),
    byModel: [],  // Nexus is agent-scoped, no per-model granularity
    byTool: [],
  };
}
```

Per-model and per-tool breakdown is not available from Nexus (agent-scoped ledger), so arrays are empty. `totalCostUsd` is derived from the balance delta.

---

## `@koi/tracing` Cost Enrichment

### Semantic Convention

```typescript
export const KOI_COST_USD = "koi.cost.usd" as const;
```

### Configuration

```typescript
const middleware = createTracingMiddleware({
  tracer,
  costEnricher: (model, inputTokens, outputTokens) => {
    return inputTokens * 0.000003 + outputTokens * 0.000015;
  },
});
```

### Behavior

- When `costEnricher` is provided AND `response.usage` exists:
  - Calls `costEnricher(model, inputTokens, outputTokens)`
  - Sets `span.setAttribute("koi.cost.usd", costUsd)`
- When absent or no usage: attribute omitted
- Errors in `costEnricher` are caught and forwarded to `onError` — never propagate

Works in both `wrapModelCall` and `wrapModelStream` (done chunk).

---

## Examples

### 1. Dashboard-Ready Cost Metrics

```typescript
import { createPayMiddleware, createInMemoryBudgetTracker, createDefaultCostCalculator } from "@koi/middleware-pay";

const middleware = createPayMiddleware({
  tracker: createInMemoryBudgetTracker(),
  calculator: createDefaultCostCalculator({
    "claude-sonnet-4": { input: 0.000003, output: 0.000015 },
    "claude-haiku-4": { input: 0.0000008, output: 0.000004 },
  }),
  budget: 50.0,
  alertThresholds: [0.5, 0.8, 0.95],
  onAlert: (pctUsed, remaining) => {
    console.warn(`Budget ${(pctUsed * 100).toFixed(0)}% used, $${remaining.toFixed(2)} remaining`);
  },
  onUsage: (info) => {
    // Push to Prometheus, Datadog, etc.
    metrics.gauge("koi.cost.total", info.totalSpent);
    metrics.gauge("koi.cost.remaining", info.remaining);
    for (const m of info.breakdown.byModel) {
      metrics.gauge("koi.cost.by_model", m.totalCostUsd, { model: m.model });
    }
    for (const t of info.breakdown.byTool) {
      metrics.gauge("koi.cost.by_tool", t.totalCostUsd, { tool: t.toolName });
    }
  },
});
```

### 2. OTel Cost Spans

```typescript
import { createTracingMiddleware } from "@koi/tracing";
import { createDefaultCostCalculator } from "@koi/middleware-pay";

const calculator = createDefaultCostCalculator({
  "claude-sonnet-4": { input: 0.000003, output: 0.000015 },
});

const tracing = createTracingMiddleware({
  costEnricher: (model, input, output) => calculator.calculate(model, input, output),
});

// Every model call span now has koi.cost.usd attribute
// → visible in Jaeger, Grafana Tempo, Datadog APM
```

### 3. Querying Breakdown Directly

```typescript
const tracker = createInMemoryBudgetTracker();

// ... after several model calls ...

const breakdown = await tracker.breakdown(sessionId);
console.log(`Total: $${breakdown.totalCostUsd.toFixed(4)}`);
for (const m of breakdown.byModel) {
  console.log(`  ${m.model}: $${m.totalCostUsd.toFixed(4)} (${m.callCount} calls)`);
}
for (const t of breakdown.byTool) {
  console.log(`  ${t.toolName}: $${t.totalCostUsd.toFixed(4)} (${t.callCount} calls)`);
}
```

---

## Testing

### Test Matrix (30 new tests)

| Package | File | New Tests | Description |
|---------|------|-----------|-------------|
| `@koi/middleware-pay` | `tracker.test.ts` | 8 | Breakdown: empty, single model, multi-model, tool agg, mixed, consistency, floating point |
| `@koi/middleware-pay` | `pay.test.ts` | 11 | Breakdown in onUsage, per-session alerts (regression), threshold cleanup, onBeforeTurn refresh |
| `@koi/pay-nexus` | `adapter.test.ts` | 3 | Breakdown method exists, totalCostUsd from balance, empty arrays |
| `@koi/tracing` | `tracing.test.ts` | 8 | Cost enrichment: positive, absent enricher, no usage, error isolation (×2 for call + stream) |

```bash
# Run all cost transparency tests
bun test packages/middleware-pay/src/tracker.test.ts
bun test packages/middleware-pay/src/pay.test.ts
bun test packages/pay-nexus/src/adapter.test.ts
bun test packages/tracing/src/tracing.test.ts
```

---

## Layer Compliance

```
L0  @koi/core/cost-tracker ──────────────────────────────────────┐
    CostEntry, CostBreakdown, ModelCostBreakdown,                 │
    ToolCostBreakdown, BudgetTracker, CostCalculator, UsageInfo   │
                                                                   │
L0  @koi/core/engine ── EngineMetrics.costUsd ────────────────────┤
L0  @koi/core/run-report ── ActionEntry.costUsd ──────────────────┤
                                                                   ▼
L2  @koi/middleware-pay ◄──────────────────────────────────────────┘
    imports from L0 + L0u only
    ✗ never imports @koi/engine (L1)
    ✗ never imports peer L2 packages

L2  @koi/pay-nexus ◄──────────────────────────────────────────────┘
    imports from L0 + L0u only

L2  @koi/tracing ◄────────────────────────────────────────────────┘
    imports from L0 + L0u + @opentelemetry/api only
```

### Performance Characteristics

| Operation | Complexity | Notes |
|-----------|-----------|-------|
| `record()` | O(1) | Incremental aggregate update |
| `totalSpend()` | O(1) | Pre-computed running sum |
| `remaining()` | O(1) | Pre-computed from running sum |
| `breakdown()` | O(models + tools) | Materializes frozen arrays from maps |
| `costEnricher` | O(1) | Sync callback, error-isolated |
| Alert check | O(thresholds) | Sorted, early-exit on first unmatched |
