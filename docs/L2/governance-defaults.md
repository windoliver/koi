# @koi/governance-defaults — Out-of-Box Governance

L2 package providing stock implementations of the governance contracts so `createRuntime({ governance: withGovernanceDefaults() })` produces a working governance stack without requiring the embedder to ship a custom `GovernanceBackend`, `GovernanceController`, or pricing table.

Complements [`@koi/governance-core`](./governance-core.md) — that package defines the middleware; this package defines the defaults it plugs into.

---

## Why It Exists

`@koi/governance-core` ships as a library: it requires the caller to supply a `GovernanceBackend` (for policy rules), a `GovernanceController` (for numeric sensors), a `CostCalculator` (for model pricing), and a `GovernanceMiddlewareConfig`. Stock `koi tui` cannot plug anything in — so governance has no effect out-of-the-box. This package ships the in-memory defaults.

- **Unblocks gov-9 (TUI surface):** needs live sensor readings to display.
- **Unblocks integration tests:** tests can swap in the in-memory controller for fast, deterministic setpoint enforcement.
- **No new contracts:** purely implements the L0 `GovernanceController` / `GovernanceBackend` surfaces and the L2 `CostCalculator` shape from `@koi/governance-core`.

---

## Architecture

```
┌──────────────────────────────────────────────┐
│  @koi/governance-defaults  (L2)              │
│                                              │
│  in-memory-controller.ts  ← numeric sensors  │
│  pattern-backend.ts       ← rule evaluator   │
│  default-pricing.ts       ← PricingEntry map │
│  with-defaults.ts         ← config helper    │
│  index.ts                 ← public API       │
└──────────────────────────────────────────────┘
Runtime deps: @koi/core, @koi/errors
Dev deps:     @koi/governance-core (tests assert structural compatibility)
```

L2 packages may only depend on L0 + L0u at runtime. `CostCalculator`, `PricingEntry`, and the middleware-config shape are mirrored locally so the value returned by `withGovernanceDefaults()` drops into `createGovernanceMiddleware` purely via TypeScript's structural typing — `validateGovernanceConfig` verifies this in test.

---

## API

```typescript
import {
  createInMemoryController,
  createPatternBackend,
  DEFAULT_PRICING,
  withGovernanceDefaults,
} from "@koi/governance-defaults";
```

### `createInMemoryController(config)`

Implements `GovernanceController` from `@koi/core/governance` with all ten well-known variables (`GOVERNANCE_VARIABLES`). Setpoints come from `config`; sensors update via `record(event)` and the first violation is returned by `checkAll()`.

```typescript
interface InMemoryControllerConfig {
  readonly tokenUsageLimit?: number;       // default: Infinity (no enforcement)
  readonly costUsdLimit?: number;          // default: Infinity
  readonly turnCountLimit?: number;        // default: Infinity
  readonly spawnDepthLimit?: number;       // default: Infinity
  readonly spawnCountLimit?: number;       // default: Infinity
  readonly durationMsLimit?: number;       // default: Infinity
  readonly forgeDepthLimit?: number;       // default: Infinity
  readonly forgeBudgetLimit?: number;      // default: Infinity
  readonly errorRateLimit?: number;        // default: Infinity
  readonly contextOccupancyLimit?: number; // default: Infinity
  readonly errorRateWindow?: number;       // default: 20 (tool outcomes)
  readonly errorRateMinSamples?: number;   // default: 3
  readonly agentDepth?: number;            // default: 0
  readonly fallbackInputUsdPer1M?: number; // default: 0 (no fallback)
  readonly fallbackOutputUsdPer1M?: number;// default: 0
  readonly now?: () => number;             // default: Date.now
}
```

**Threshold semantics** — bounded counters and rates fail when the current value **reaches** the limit (`>=`); `spawn_depth` is the only exception and fails only strictly above its limit. Mirrors `@koi/engine-reconcile`'s governance-controller. Every sensor is enforced only when its limit is finite, so a zero-config controller never self-bricks.

**`retryable` flag** — `spawn_count`, `error_rate`, and `context_occupancy` are transient (back off and retry). Everything else is terminal.

**`spawn_depth` sensor** — reads the controller's own `agentDepth` (passed in config). It is **not** mutated by `spawn` / `spawn_release` events, which track concurrent live children via `spawn_count`.

**Cost fallback** — when a `token_usage` event omits `costUsd` (e.g. because `cost.calculate()` threw for an unknown model) and non-zero `fallback*UsdPer1M` rates are configured, the controller applies per-token pricing so the spend cap still advances. Invalid `costUsd` (NaN / negative / Infinity) is rejected so a buggy calculator cannot poison the accumulator.

**`context_occupancy` sensor** — there is no L0 event that sets it. Hosts call `controller.setContextOccupancy(fraction)` (an extension method on `InMemoryController`) to drive it, typically from a context-manager hook.

**Reset semantics** — see comments on `GovernanceEvent` in `@koi/core/governance`:

| Event | What resets |
|-------|-------------|
| `iteration_reset` | `turn_count`, `duration_ms` start. NOT token/cost/spawn/error-rate. |
| `session_reset` | `turn_count`, `duration_ms`, rolling `error_rate` window. NOT token/cost/spawn. |

**Forge caveat** — the L0 `GovernanceEvent` union has no `forge_release` event, so the default controller cannot track real nesting depth. `forge_depth` and `forge_budget` both read the cumulative forge-event counter. Hosts that need true depth accounting must supply their own `GovernanceController`.

### `createPatternBackend(config)`

Implements `GovernanceBackend` from `@koi/core/governance-backend` with a rule list. **Last-match-wins** — later rules override earlier ones. If no rule matches and `defaultDeny` is true, the request is denied with a `default-deny` violation; otherwise allowed.

```typescript
interface PatternRule {
  readonly match: {
    readonly kind?: PolicyRequestKind | undefined;
    readonly toolId?: string | undefined; // matched against payload.toolId for tool_call
    readonly model?: string | undefined;  // matched against payload.model for model_call
  };
  readonly decision: "allow" | "deny";
  readonly rule?: string | undefined;     // default: "pattern.<idx>"
  readonly severity?: ViolationSeverity | undefined; // default: "critical"
  readonly message?: string | undefined;  // default: "denied by pattern backend"
}

interface PatternBackendConfig {
  readonly rules: readonly PatternRule[];
  readonly defaultDeny?: boolean | undefined; // default: false
}
```

### `DEFAULT_PRICING`

Frozen `Record<string, PricingEntry>` keyed by canonical model id. Plain data — pass to `createFlatRateCostCalculator(DEFAULT_PRICING)` or spread with overrides:

```typescript
const pricing = { ...DEFAULT_PRICING, "my-custom-model": { inputUsdPer1M: 1, outputUsdPer1M: 5 } };
```

Models covered (USD per 1M tokens, list price as of 2026-04):

| Model | Input | Output |
|-------|-------|--------|
| `gpt-4o` | 2.50 | 10.00 |
| `gpt-4o-mini` | 0.15 | 0.60 |
| `gpt-5` | 1.25 | 10.00 |
| `gpt-5-mini` | 0.25 | 2.00 |
| `claude-opus-4-7` | 15.00 | 75.00 |
| `claude-sonnet-4-6` | 3.00 | 15.00 |
| `claude-haiku-4-5` | 1.00 | 5.00 |

Not bundled tightly — a plain `Record` the caller can override.

### `withGovernanceDefaults(overrides?)`

Returns a `DefaultGovernanceConfig` — structurally identical to governance-core's `GovernanceMiddlewareConfig`, so it passes `validateGovernanceConfig` and drops into `createGovernanceMiddleware`. Zero required args. Every sub-component can be overridden.

```typescript
function withGovernanceDefaults(overrides?: {
  readonly controller?: GovernanceController;
  readonly backend?: GovernanceBackend;
  readonly cost?: CostCalculator;
  readonly pricing?: Readonly<Record<string, PricingEntry>>;
  readonly controllerConfig?: InMemoryControllerConfig;
  readonly rules?: readonly PatternRule[];
  readonly defaultDeny?: boolean;
  readonly alertThresholds?: readonly number[];
  readonly onAlert?: AlertCallback;
  readonly onViolation?: ViolationCallback;
  readonly onUsage?: UsageCallback;
}): GovernanceMiddlewareConfig;
```

Usage:

```typescript
import { createRuntime } from "@koi/runtime";
import { withGovernanceDefaults } from "@koi/governance-defaults";

const runtime = createRuntime({
  governance: withGovernanceDefaults({
    controllerConfig: { costUsdLimit: 5.0, turnCountLimit: 50 },
    rules: [{ match: { toolId: "Bash" }, decision: "deny" }],
  }),
});
```

---

## Fail-Closed Contract

Inherited from `@koi/governance-core`:
- Rule evaluator never throws — pure in-memory matching.
- Controller `checkAll()` never throws — returns `{ ok: false, variable, reason }` on violation.
- No I/O, no async resources, no cleanup needed.

---

## Out of Scope

- **Persistent compliance storage** — use `@koi/audit-sink-*` via `@koi/middleware-audit`.
- **Complex policy languages (OPA, Cedar)** — implement your own `GovernanceBackend`.
- **Model price auto-discovery** — pricing is a static table; caller updates as providers change prices.
- **Spawn-depth inheritance** — engine's responsibility (#1473); children derive their own controller.

---

## See Also

- [`@koi/governance-core`](./governance-core.md) — middleware that consumes this config
- [`@koi/core/governance`](../../packages/kernel/core/src/governance.ts) — `GovernanceController`, `GovernanceEvent`, `GOVERNANCE_VARIABLES`
- [`@koi/core/governance-backend`](../../packages/kernel/core/src/governance-backend.ts) — `GovernanceBackend`, `PolicyRequest`, `GovernanceVerdict`
