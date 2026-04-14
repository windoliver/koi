# @koi/cost-aggregator — Real-time Cost Aggregation

Real-time cost tracking with per-model, per-tool, per-agent, and per-provider breakdowns. Implements `BudgetTracker` from `@koi/core` with O(1) pre-aggregated queries, tiered pricing, and exactly-once soft warnings.

---

## Why It Exists

Cost transparency is table stakes for LLM applications. Users need real-time visibility into spend per session, per agent, and per provider — not after-the-fact log mining. This package provides the aggregation engine that powers the TUI cost dashboard, JSON export, and budget enforcement.

---

## Architecture

```
┌─────────────────────────────────────────────────┐
│  @koi/cost-aggregator  (L2)                     │
│                                                 │
│  tracker.ts      ← BudgetTracker impl (O(1))   │
│  calculator.ts   ← CostCalculator + tiered      │
│  pricing.ts      ← bundled LiteLLM pricing      │
│  ring-buffer.ts  ← bounded audit trail           │
│  thresholds.ts   ← exactly-once soft warnings   │
│  index.ts        ← public API                   │
└─────────────────────────────────────────────────┘
Dependencies: @koi/core
```

Zero external dependencies. Pure in-memory implementation.

---

## Data Flow

```
Engine → middleware-pay → tracker.record(entry)
                              │
                    ┌─────────┼──────────┐
                    ▼         ▼          ▼
              Pre-aggregated  Ring     Threshold
              Maps (O(1))    Buffer    Tracker
                    │                    │
                    ▼                    ▼
              breakdown()           onAlert()
                    │
          ┌─────────┼──────────┐
          ▼         ▼          ▼
    TUI View   JSON Export   Budget Gate
```

---

## Key Design Decisions

| Decision | Choice | Why |
|----------|--------|-----|
| Storage | Hybrid: pre-aggregated Maps + ring buffer | O(1) reads for dashboard, audit trail for export |
| Ring buffer | 10K entries (~2MB cap) | 99% of sessions never hit cap; recent > old for debugging |
| Pricing source | Bundled LiteLLM JSON + config override | MIT licensed, 100+ models, no network dep |
| Model aliasing | Map lookup + date-suffix fallback | Handles `gpt-4o-20241120` → `gpt-4o` |
| Thresholds | Exactly-once per session, skip-over safe | No duplicate alerts, no missed alerts on jump |
| CostCalculator | Optional `calculateDetailed` method | Non-breaking addition for tiered pricing |
| Return types | Sync-only (narrowed from L0 contract) | In-memory implementation, no I/O |

---

## Usage

### Basic cost tracking

```typescript
import { createCostAggregator, createCostCalculator } from "@koi/cost-aggregator";

const aggregator = createCostAggregator();
const calculator = createCostCalculator();

// Record a model call
const costUsd = calculator.calculateDetailed!("claude-sonnet-4-6", {
  inputTokens: 1000,
  outputTokens: 500,
  cachedInputTokens: 800,
});

aggregator.record("session-1", {
  model: "claude-sonnet-4-6",
  inputTokens: 1000,
  outputTokens: 500,
  costUsd,
  timestamp: Date.now(),
  provider: "anthropic",
  agentId: "agent-1",
});

// Query breakdown
const breakdown = aggregator.breakdown("session-1");
// breakdown.byModel, breakdown.byProvider, breakdown.byAgent, breakdown.byTool
```

### With soft warnings

```typescript
import { createCostAggregator, createThresholdTracker } from "@koi/cost-aggregator";

const thresholdTracker = createThresholdTracker({
  budget: 5.0, // $5 budget
  thresholds: [0.5, 0.75, 0.9],
  onAlert: (alert) => {
    console.log(`Budget ${(alert.threshold * 100)}% reached: $${alert.currentSpend.toFixed(2)}`);
  },
});

const aggregator = createCostAggregator({ thresholdTracker });
```

### Custom model pricing

```typescript
import { createCostCalculator } from "@koi/cost-aggregator";

const calculator = createCostCalculator({
  pricingOverrides: {
    "my-private-model": { input: 5e-6, output: 20e-6 },
  },
});
```

---

## Tiered Pricing

Modern LLM providers use tiered token pricing. The `calculateDetailed` method handles:

| Token Type | Anthropic Rate | OpenAI Rate |
|-----------|---------------|-------------|
| Regular input | 1x base | 1x base |
| Cached input (read) | 0.1x base | 0.5x base |
| Cache creation (write) | 1.25x base | N/A |
| Reasoning/thinking | Output rate | Output rate |

Without tiered pricing, cost attribution is systematically wrong on every call that involves caching or reasoning.

---

## Test Coverage

68 tests across 4 files:

| File | Tests | Coverage |
|------|-------|----------|
| `ring-buffer.test.ts` | 8 | Wrap, clear, capacity edge cases |
| `calculator.test.ts` | 20 | All 6 pricing edge cases (cached, reasoning, aliasing, zero, float) |
| `thresholds.test.ts` | 14 | Exactly-once, skip-over, re-crossing, per-session isolation |
| `tracker.test.ts` | 26 | All 4 dimensions, cross-session, ring buffer integration, threshold wiring |
