# @koi/governance-core — Governance Middleware Bundle

L2 middleware that gates every model call and tool call through a pluggable `GovernanceBackend.evaluator` and enforces numeric `GovernanceController` setpoints (token usage, cost, turn count, spawn depth). Records token/cost events after each successful model call and emits best-effort compliance records for audit.

---

## Position in the middleware chain

- 50 — exfiltration-guard
- 100 — permissions (rule-based tool allow/deny)
- **150 — governance-core (this package)**
- 300 — audit

---

## Fail-closed contract

- `evaluator.evaluate()` throws → `POLICY_VIOLATION` with `cause` preserved
- `controller.checkAll()` throws → `POLICY_VIOLATION` with `cause`
- `compliance.recordCompliance()` fails → warn and swallow; denial decision is authoritative

---

## Architecture

`@koi/governance-core` is an **L2 feature package** — depends on `@koi/core` (L0), `@koi/errors` (L0u), and `@koi/validation` (L0u).

```
┌────────────────────────────────────────────────────────────┐
│  @koi/governance-core  (L2)                                 │
│                                                            │
│  config.ts              ← config + validation              │
│  cost-calculator.ts     ← CostCalculator interface + impl  │
│  normalize-usage.ts     ← provider usage normalization     │
│  alert-tracker.ts       ← per-session threshold dedup      │
│  governance-middleware  ← createGovernanceMiddleware       │
│  index.ts              ← public API surface                │
│                                                            │
├────────────────────────────────────────────────────────────┤
│  Dependencies                                              │
│                                                            │
│  @koi/core      KoiMiddleware, GovernanceBackend,          │
│                 GovernanceController, PolicyRequest,        │
│                 GovernanceVerdict, SessionContext,          │
│                 TurnContext, ModelResponse                  │
│                                                            │
│  @koi/errors    KoiRuntimeError                            │
│  @koi/validation Result type                               │
└────────────────────────────────────────────────────────────┘
```

---

## Data flow

### Pre-call gate (shared by `wrapModelCall`, `wrapModelStream`, `wrapToolCall`)

```ts
gate(ctx, kind, payload):
  // 1. Check numeric setpoints first (fail-fast, cheap)
  check = await controller.checkAll()
  if !check.ok:
    onViolation?(verdict, request)
    throw RATE_LIMIT with check.variable

  // 2. Evaluate policy through backend (may be async, network I/O)
  req = { kind, agentId: ctx.session.agentId, payload, timestamp: Date.now() }
  try:
    verdict = await backend.evaluator.evaluate(req)
  catch (e):
    throw POLICY_VIOLATION with cause

  // 3. If policy denies, record compliance and throw
  if !verdict.ok:
    onViolation?(verdict, request)
    void backend.compliance?.recordCompliance({...}).catch(logWarn)
    throw POLICY_VIOLATION

  // 4. Gate passed; call will proceed
```

### Post-call recording (after successful `model_call`)

```ts
onModelCallComplete(response):
  usage = normalizeUsage(response.usage)
  cost = calculator.calculate(modelId, usage.inputTokens, usage.outputTokens)

  // 1. Record event into controller setpoints
  await controller.record({ kind: "token_usage", inputTokens, outputTokens, cacheReadTokens, ... })

  // 2. Check threshold alerts and emit once per session
  alert = alertTracker.check(cost / costLimit)
  if alert:
    onAlert?(alert.pctUsed, "cost", reading)

  // 3. Best-effort compliance record (non-blocking)
  void backend.compliance?.recordCompliance({
    timestamp: Date.now(),
    agentId: ctx.session.agentId,
    kind: "token_usage",
    usage,
    costUsd: cost,
    verdict: { ok: true },
  }).catch(logWarn)

  // 4. Emit usage event to caller
  onUsage?.({ model, usage, costUsd: cost })
```

---

## API

```typescript
// Factory
export function createGovernanceMiddleware(
  config: GovernanceMiddlewareConfig,
): KoiMiddleware;

// Config
export interface GovernanceMiddlewareConfig {
  readonly backend: GovernanceBackend;          // L0 — required
  readonly controller: GovernanceController;    // L0 — required
  readonly cost: CostCalculator;                // this pkg — required
  readonly alertThresholds?: readonly number[]; // default [0.8, 0.95]
  readonly onAlert?: AlertCallback;
  readonly onViolation?: ViolationCallback;
  readonly onUsage?: UsageCallback;
}

// Constants
export const GOVERNANCE_MIDDLEWARE_NAME = "koi:governance-core";
export const GOVERNANCE_MIDDLEWARE_PRIORITY = 150;
export const DEFAULT_ALERT_THRESHOLDS: readonly number[] = [0.8, 0.95];

// Validation (expected failure = Result<T, E>)
export function validateGovernanceConfig(
  input: unknown,
): Result<GovernanceMiddlewareConfig, KoiError>;

// Cost calculation
export interface CostCalculator {
  readonly calculate: (
    model: string,
    inputTokens: number,
    outputTokens: number,
  ) => number;
}
export function createFlatRateCostCalculator(
  pricing: Readonly<
    Record<string, { readonly inputUsdPer1M: number; readonly outputUsdPer1M: number }>
  >,
): CostCalculator;

// Usage normalization (provider-agnostic)
export interface NormalizedUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly reasoningTokens: number;
}
export function normalizeUsage(
  usage: ModelResponse["usage"] | undefined,
): NormalizedUsage;

// Callback types
export type AlertCallback = (
  pctUsed: number,
  variable: string,
  reading: SensorReading,
) => void;
export type ViolationCallback = (
  verdict: GovernanceVerdict,
  request: PolicyRequest,
) => void;
export type UsageCallback = (event: {
  readonly model: string;
  readonly usage: NormalizedUsage;
  readonly costUsd: number;
}) => void;
```

All exported functions have explicit return types (TS 6 `isolatedDeclarations`). All interfaces `readonly`. No `class`, `enum`, `namespace`, `any`.

---

## Budget inheritance

Spawn-depth budget inheritance is the **engine's responsibility** (issue #1473).

Parent agents record events with `{ kind: "spawn", depth }`. Child agents receive a **derived `GovernanceController`** via `SubsystemToken<GovernanceController>` at assembly time, with depth-based quotas pre-adjusted by the engine.

This package documents the contract but does not implement budget derivation; that lives in `@koi/engine` L1.

---

## Out of scope

- **URL / filesystem / credentials scope subsystem** — follow-up package
- **Approval / deferral UX (three-tier allow/deny/ask)** — requires L0 `GovernanceVerdict` extension
- **Persistent compliance storage** — use `@koi/audit-sink-*` packages

---

## Testing

Unit tests colocated with source:

- `config.test.ts` — validation, edge cases
- `cost-calculator.test.ts` — pricing math, edge cases
- `normalize-usage.test.ts` — provider normalization for Anthropic/Bedrock/Vertex
- `alert-tracker.test.ts` — once-per-session dedup logic
- `governance-middleware.test.ts` — gate flow, fail-closed contract, pre/post hooks

Integration + API-surface snapshot in `src/__tests__/`:

- `governance-middleware.test.ts` — full middleware stack with mocked backend/controller
- `api-surface.test.ts` — ensures public API matches spec (rerun on any export change)

Target: 80%+ coverage (enforced in CI).
