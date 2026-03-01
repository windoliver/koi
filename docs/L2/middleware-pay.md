# @koi/middleware-pay — Token Budget Enforcement

Tracks token costs per model/tool call, enforces budget limits, and fires alerts on threshold crossings. Pluggable via the L0 `PayLedger` interface — swap the in-memory ledger for a persistent backend (e.g., `@koi/pay-nexus`) with zero code changes.

---

## Why It Exists

LLM calls cost money. Without enforcement, a runaway agent loop can burn through an entire API budget in seconds. This middleware solves three problems:

1. **Hard budget cap** — model/tool calls are blocked once the budget is exhausted (fail-closed)
2. **Cost tracking** — every model call's token usage is metered and recorded via `PayLedger`
3. **Threshold alerts** — callbacks fire when spend crosses configurable percentages (e.g., 80%, 95%)

Without this package, every agent would reimplement cost calculation, budget checking, and alert logic.

---

## Architecture

`@koi/middleware-pay` is an **L2 feature package** — it depends only on L0 (`@koi/core`) and L0u utilities (`@koi/errors`). Zero external dependencies.

```
┌────────────────────────────────────────────────────────────┐
│  @koi/middleware-pay  (L2)                                   │
│                                                              │
│  tracker.ts         ← CostCalculator + createInMemoryPayLedger│
│  config.ts          ← PayMiddlewareConfig + validation       │
│  pay.ts             ← middleware factory (core logic)        │
│  descriptor.ts      ← BrickDescriptor for manifest resolution│
│  index.ts           ← public API surface                     │
│                                                              │
├──────────────────────────────────────────────────────────────┤
│  Dependencies                                                │
│                                                              │
│  @koi/core    (L0)   KoiMiddleware, ModelRequest/Response,   │
│                       ToolRequest/Response, TurnContext,      │
│                       PayLedger, PayBalance, PayMeterResult   │
│  @koi/errors  (L0u)  KoiRuntimeError                         │
│  @koi/resolve (L0u)  BrickDescriptor                         │
└──────────────────────────────────────────────────────────────┘
```

---

## How It Works

### Budget Enforcement Flow

```
  Model/Tool call
       │
       ▼
  ┌──────────────┐     budget <= 0?      ┌──────────────┐
  │ checkBudget()│────── yes ───────────▶│ throw        │
  │              │                        │ RATE_LIMIT   │
  │  ledger      │                        └──────────────┘
  │  .getBalance()│
  └──────┬───────┘
         │ no
         ▼
  ┌──────────────┐
  │ next(request)│  ← call the LLM / tool
  └──────┬───────┘
         │
         ▼
  ┌──────────────┐
  │ recordCost() │  ← ledger.meter() + getBalance()
  │              │     fire alerts if threshold crossed
  │              │     call onUsage() callback
  └──────────────┘
```

1. **Pre-check**: Before every model call, stream, or tool call, `checkBudget()` queries `ledger.getBalance()`. If remaining budget is zero and `hardKill` is enabled, throws `RATE_LIMIT`.

2. **Execute**: The underlying model/tool call proceeds normally.

3. **Record**: After the model response arrives (with token usage), `recordCost()` calls `ledger.meter()` with the computed USD cost, then fetches the updated balance. If spend crosses any alert threshold, the `onAlert` callback fires. The `onUsage` callback receives the full cost breakdown.

### PayLedger Interface (L0)

The middleware depends on `PayLedger` from `@koi/core/pay-ledger` — a contract with 7 methods. Only 2 are used by the middleware:

| Method | Used by middleware | Purpose |
|--------|-------------------|---------|
| `getBalance()` | Yes | Check remaining budget before calls |
| `meter(amount, eventType?)` | Yes | Record cost after model calls |
| `canAfford(amount)` | No | Available for consumers |
| `transfer(to, amount, memo?)` | No | Agent-to-agent payments |
| `reserve(amount, timeout?, purpose?)` | No | Reserve credits |
| `commit(reservationId, actualAmount?)` | No | Finalize reservation |
| `release(reservationId)` | No | Cancel reservation |

This means the in-memory ledger only needs to implement `meter`, `getBalance`, and `canAfford`. The remaining methods throw "not implemented".

### Backend Pluggability

```
┌──────────────────────────────────────────────────────┐
│  @koi/middleware-pay                                   │
│  Uses PayLedger — identical regardless of backend      │
└───────────────────────────┬──────────────────────────┘
                            │
         ┌──────────────────┼──────────────────┐
         ▼                  ▼                  ▼
┌──────────────────┐ ┌──────────────┐ ┌──────────────────┐
│ In-Memory Ledger  │ │  (future)    │ │  @koi/pay-nexus  │
│ Dev/testing only  │ │  SQLite      │ │  Production      │
│ createInMemory..()│ │  ledger      │ │  createNexus..() │
└──────────────────┘ └──────────────┘ └──────────────────┘
```

---

## API Reference

### `createPayMiddleware(config)`

Creates a KoiMiddleware that enforces token budgets.

```typescript
import { createPayMiddleware, createInMemoryPayLedger, createDefaultCostCalculator } from "@koi/middleware-pay";

const middleware = createPayMiddleware({
  ledger: createInMemoryPayLedger(50.0),
  calculator: createDefaultCostCalculator(),
  budget: 50.0,
  hardKill: true,
  alertThresholds: [0.8, 0.95],
  onAlert: (pctUsed, remaining) => console.warn(`Budget ${(pctUsed * 100).toFixed(0)}% used`),
  onUsage: (info) => console.log(`$${info.costUsd.toFixed(4)} for ${info.model}`),
});
```

### `PayMiddlewareConfig`

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `ledger` | `PayLedger` | required | Budget tracking backend |
| `calculator` | `CostCalculator` | required | Computes USD cost from token counts |
| `budget` | `number` | required | Maximum USD budget |
| `hardKill` | `boolean` | `true` | Throw on exhaustion (vs. soft warning) |
| `alertThresholds` | `readonly number[]` | `[0.8, 0.95]` | Percentage thresholds for alerts |
| `onAlert` | `(pctUsed, remaining) => void` | - | Fires when threshold crossed |
| `onUsage` | `(info: UsageInfo) => void` | - | Fires after each cost recording |

### `createInMemoryPayLedger(initialBudget)`

Creates an in-memory `PayLedger` for development and testing. Tracks cumulative spend internally.

```typescript
const ledger = createInMemoryPayLedger(10.0);
```

Throws if `initialBudget` is negative, NaN, or Infinity.

### `createDefaultCostCalculator(rates?)`

Creates a `CostCalculator` with per-token pricing. Falls back to default rates ($3/$15 per million input/output tokens) for unknown models.

```typescript
const calculator = createDefaultCostCalculator({
  "claude-sonnet-4-6": { input: 0.000003, output: 0.000015 },
  "claude-haiku-4-5": { input: 0.0000008, output: 0.000004 },
});
```

### `UsageInfo`

Passed to the `onUsage` callback after each model call:

| Field | Type | Description |
|-------|------|-------------|
| `model` | `string` | Model name from response |
| `costUsd` | `number` | Computed cost for this call |
| `inputTokens` | `number` | Input token count |
| `outputTokens` | `number` | Output token count |
| `totalSpent` | `number` | Cumulative spend so far |
| `remaining` | `number` | Budget remaining |

### `validatePayConfig(config)`

Validates a raw config object, returning `Result<PayMiddlewareConfig, KoiError>`.

---

## Examples

### 1. Basic budget enforcement

```typescript
import {
  createPayMiddleware,
  createInMemoryPayLedger,
  createDefaultCostCalculator,
} from "@koi/middleware-pay";

const middleware = createPayMiddleware({
  ledger: createInMemoryPayLedger(5.0),
  calculator: createDefaultCostCalculator(),
  budget: 5.0,
});
// Pass to createKoi({ middleware: [middleware], ... })
```

### 2. Production with Nexus backend

```typescript
import { createNexusPayLedger } from "@koi/pay-nexus";
import { createPayMiddleware, createDefaultCostCalculator } from "@koi/middleware-pay";

const ledger = createNexusPayLedger({
  baseUrl: process.env.NEXUS_PAY_URL!,
  apiKey: process.env.NEXUS_PAY_KEY!,
});

const middleware = createPayMiddleware({
  ledger,
  calculator: createDefaultCostCalculator(),
  budget: 50.0,
});
```

### 3. Manifest-driven (via descriptor)

```yaml
# agent.koi.yaml
middleware:
  - name: pay
    options:
      budget: 10.0
```

The descriptor auto-creates an in-memory ledger with default cost calculator.

### 4. With alerts and usage tracking

```typescript
const middleware = createPayMiddleware({
  ledger: createInMemoryPayLedger(100),
  calculator: createDefaultCostCalculator(),
  budget: 100,
  alertThresholds: [0.5, 0.8, 0.95],
  onAlert: (pctUsed, remaining) => {
    console.warn(`[pay] ${(pctUsed * 100).toFixed(0)}% used — $${remaining.toFixed(2)} remaining`);
  },
  onUsage: (info) => {
    console.log(`[pay] ${info.model}: $${info.costUsd.toFixed(4)} (${info.inputTokens}in/${info.outputTokens}out)`);
  },
});
```

---

## Middleware Properties

| Property | Value |
|----------|-------|
| `name` | `"pay"` |
| `priority` | `200` |
| Hooks implemented | `wrapModelCall`, `wrapModelStream`, `wrapToolCall`, `describeCapabilities` |

**Priority 200** means pay runs after permissions (100) but before audit (300) and memory (400).

---

## Safety Properties

- **Fail-closed**: Invalid balance data (NaN, malformed strings) throws `INTERNAL` error rather than silently allowing unlimited spend
- **Hard kill**: When `hardKill: true` (default), budget exhaustion throws `RATE_LIMIT` — the LLM is never called
- **Precision**: Cost amounts are serialized with `toFixed(10)` to avoid floating-point string artifacts at the PayLedger boundary
- **Input validation**: `createInMemoryPayLedger` rejects negative, NaN, and Infinity budgets at construction time

---

## Testing

```bash
bun test packages/middleware-pay/src/
```

| File | Tests | Focus |
|------|-------|-------|
| `tracker.test.ts` | 18 | In-memory ledger, cost calculator, input validation |
| `pay.test.ts` | 31 | Budget enforcement, alerts, usage callbacks, streams |
| `config.test.ts` | 13 | Config validation edge cases |
| `api-surface.test.ts` | 2 | .d.ts snapshot stability |

---

## Layer Compliance

```
L0  @koi/core ── PayLedger, KoiMiddleware, Model/ToolRequest ──┐
L0u @koi/errors ── KoiRuntimeError ────────────────────────────┤
L0u @koi/resolve ── BrickDescriptor ───────────────────────────┤
                                                                ▼
L2  @koi/middleware-pay ◄───────────────────────────────────────┘
    imports from L0 + L0u only
    ✗ never imports @koi/engine (L1)
    ✗ never imports peer L2 packages
```
