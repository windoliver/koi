# `@koi/governance-core` — Design Spec

**Issue:** #1392 (v2 Phase 3-gov-1)
**Date:** 2026-04-16
**Status:** Approved (brainstorm complete; writing-plans next)

---

## 1. Summary

L2 middleware package that gates every model call and tool call through a pluggable `GovernanceBackend.evaluator` (fail-closed) and a numeric `GovernanceController` (setpoints for token usage, cost, turn count, spawn depth). After each successful model call, normalizes provider-specific usage, computes cost, and records the event into the controller. Emits best-effort compliance records to the backend for audit trails.

Composes with existing `@koi/middleware-permissions` (priority 100) by running at priority 150 — permissions denies by pattern first (cheap), governance then evaluates richer policy and budget.

Budget: ~500 LOC, target 80%+ coverage, zero external deps beyond `@koi/core` + `@koi/errors` + `@koi/validation`.

---

## 2. Scope & non-scope

**In scope**
- One factory: `createGovernanceMiddleware(config)` returning a `KoiMiddleware`
- Uniform gate for `model_call` / `tool_call` via L0 `PolicyEvaluator`
- Setpoint enforcement via L0 `GovernanceController.checkAll()`
- Post-call token/cost recording via `GovernanceController.record({kind:"token_usage", ...})`
- Best-effort compliance recording via `GovernanceBackend.compliance?.recordCompliance`
- Provider-usage normalization (Anthropic / Bedrock / Vertex / generic) — ported from opencode's `getUsage()`
- Threshold alerts (`[0.8, 0.95]` default) with once-per-session dedup
- `describeCapabilities` surface for TUI display

**Out of scope**
- URL / filesystem / credentials scope subsystem (v1 `scope` package) — follow-up issue
- Approval / deferral UX (three-tier `allow/deny/ask`) — L0 `GovernanceVerdict` is binary today; "ask" tier is a follow-up L0 extension
- Spawn-depth budget inheritance — engine (v2 Phase 3-gov-6, #1473) owns; this MW documents the contract
- Persistent compliance storage — `@koi/audit-sink-*` packages own persistence
- Bash command classification / ARITY table — defer until governance scopes bash

---

## 3. Package layout

Location: `packages/security/governance-core/`

```
src/
├── index.ts                     public re-exports                      ~40 LOC
├── config.ts                    config type + validateGovernanceConfig ~80 LOC
├── cost-calculator.ts           CostCalculator type + flat-rate impl   ~60 LOC
├── normalize-usage.ts           provider usage normalizer              ~70 LOC
├── alert-tracker.ts             per-session threshold dedup            ~50 LOC
├── governance-middleware.ts     createGovernanceMiddleware factory    ~200 LOC
└── __tests__/
    ├── governance-middleware.test.ts
    ├── api-surface.test.ts
    ├── <colocated unit tests per module>
```

`<name>.test.ts` colocated with source per CLAUDE.md. `__tests__/` reserved for integration + API-surface snapshot.

Dependencies (`package.json`):
```json
{
  "dependencies": {
    "@koi/core": "workspace:*",
    "@koi/errors": "workspace:*",
    "@koi/validation": "workspace:*"
  },
  "koi": { "optional": true }
}
```

---

## 4. Public API

```ts
// Factory
export function createGovernanceMiddleware(config: GovernanceMiddlewareConfig): KoiMiddleware;

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

// Validation (expected failure = value)
export function validateGovernanceConfig(
  input: unknown,
): Result<GovernanceMiddlewareConfig, KoiError>;

// Cost
export interface CostCalculator {
  readonly calculate: (model: string, inputTokens: number, outputTokens: number) => number;
}
export function createFlatRateCostCalculator(
  pricing: Readonly<Record<string, { readonly inputUsdPer1M: number; readonly outputUsdPer1M: number }>>,
): CostCalculator;

// Usage normalization (ported from opencode)
export interface NormalizedUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly reasoningTokens: number;
}
export function normalizeUsage(usage: ModelResponse["usage"] | undefined): NormalizedUsage;

// Callback types
export type AlertCallback = (pctUsed: number, variable: string, reading: SensorReading) => void;
export type ViolationCallback = (verdict: GovernanceVerdict, request: PolicyRequest) => void;
export type UsageCallback = (event: { readonly model: string; readonly usage: NormalizedUsage; readonly costUsd: number }) => void;
```

All exported functions have explicit return types (TS 6 `isolatedDeclarations`). All interfaces `readonly`. No `class`, `enum`, `namespace`, `any`.

---

## 5. Data flow

**Pre-call gate (shared by `wrapModelCall`, `wrapModelStream`, `wrapToolCall`):**

```
gate(ctx, kind, payload):
  check = await controller.checkAll()
  if !check.ok:
    synth = { ok: false, violations: [{ rule: check.variable, severity: "critical", message: check.reason }] }
    onViolation?(synth, req)
    throw KoiRuntimeError.from("RATE_LIMIT", `Governance setpoint exceeded: ${check.variable}`, { context })

  req = { kind, agentId: ctx.session.agentId, payload, timestamp: Date.now() }
  try:
    verdict = await backend.evaluator.evaluate(req)
  catch (e):
    throw KoiRuntimeError.from("POLICY_VIOLATION", "Governance backend evaluation failed", { cause: e, context })

  if !verdict.ok:
    onViolation?(verdict, req)
    void backend.compliance?.recordCompliance({ ... }).catch(logWarn)
    throw KoiRuntimeError.from("POLICY_VIOLATION", joinMsgs(verdict.violations), { context })

  # success: best-effort record of allow decision
  void backend.compliance?.recordCompliance({ ..., verdict: GOVERNANCE_ALLOW }).catch(logWarn)
```

**`wrapModelCall`:**
1. `await gate(ctx, "model_call", { model: request.model })`
2. `response = await next(request)`
3. If `response.usage`:
   - `usage = normalizeUsage(response.usage)`
   - `costUsd = cost.calculate(response.model, usage.inputTokens, usage.outputTokens)`
   - `await controller.record({ kind: "token_usage", count: usage.inputTokens + usage.outputTokens, inputTokens: ..., outputTokens: ..., costUsd })`
   - `const snapshot = await controller.snapshot()` (L0 signature is `() => GovernanceSnapshot | Promise<GovernanceSnapshot>`)
   - `alertTracker.checkAndFire(ctx.session.sessionId, snapshot, onAlert)`
   - `onUsage?({ model: response.model, usage, costUsd })`
4. `return response`

**`wrapModelStream`:** identical, but record fires inside `for await` on `chunk.kind === "done"`. Gate runs before first yield.

**`wrapToolCall`:** `gate` only; no usage recording (tool calls don't consume model tokens directly in this MW).

**`onBeforeTurn`:** pre-warm alert tracker using current controller snapshot so first threshold crossing fires promptly.

**`onSessionEnd`:** `alertTracker.cleanup(ctx.session.sessionId)`. Does **not** call `backend.dispose()` (backend lifecycle owned by creator, not this MW).

**`describeCapabilities`:** returns `{ label: "governance", description: formatBudgetSummary(controller.snapshot()) }`. Reads only, never queries backend.

---

## 6. Error taxonomy & fail-closed contract

| Trigger | Code | Retryable |
|---|---|---|
| `controller.checkAll()` → `{ok:false}` | `RATE_LIMIT` | false |
| `controller.checkAll()` throws | `POLICY_VIOLATION` | false |
| `evaluator.evaluate()` → `{ok:false}` | `POLICY_VIOLATION` | false |
| `evaluator.evaluate()` throws | `POLICY_VIOLATION` | false |
| `cost.calculate()` throws / returns NaN / returns negative | `INVALID_ARGUMENT` | false |

All via `KoiRuntimeError.from(code, message, { cause, context })`. `cause` preserved for diagnostics.

**Fail-closed rules:**
1. Evaluator throws → deny. Never silently allow.
2. Controller throws → deny. Broken sensor = deny.
3. Compliance record fails → warn, do **not** block. Decision is authoritative.
4. `normalizeUsage` handles unknown providers → zero cache/reasoning, never throws.

**Error context payload (no PII):**
```ts
context: {
  agentId, sessionId, kind, timestamp,
  payload: { model?: string, toolId?: string },   // NEVER raw tool input bodies
  variable?: string,                              // when RATE_LIMIT
  violations?: readonly { rule, severity }[],     // rule id + severity only
}
```

Only two `catch` blocks in the package: compliance best-effort (warn+swallow), evaluator wrap (log+re-throw with cause). No empty catches.

---

## 7. Composition & priority

```
50   middleware-exfiltration-guard     (runs first)
100  middleware-permissions            (pattern allow/deny)
150  governance-core                   ← this package
300  middleware-audit                  (runs last)
```

Priority `150` is fixed, non-configurable. Permissions runs first (cheap) so pattern-denied tools never hit the evaluator. Audit runs last so it records both allowed and denied governance outcomes.

**Runtime wiring (`@koi/runtime`):**

```ts
if (opts.governance) {
  // DEFAULT_PRICING lives in @koi/runtime (provider-specific, not this package's concern).
  middlewares.push(createGovernanceMiddleware({
    backend: opts.governance.backend,
    controller: opts.governance.controller,
    cost: opts.governance.cost ?? createFlatRateCostCalculator(RUNTIME_DEFAULT_PRICING),
    alertThresholds: opts.governance.alertThresholds,
    onAlert: opts.governance.onAlert,
    onViolation: opts.governance.onViolation,
    onUsage: opts.governance.onUsage,
  }));
}
```

**Budget inheritance (documented, not implemented here):**
Parent engine calls `controller.record({kind:"spawn", depth})`; child agents receive a derived `GovernanceController` via `SubsystemToken<GovernanceController>` at assembly time. Spawn lifecycle owned by #1473.

---

## 8. Testing plan

Mapped 1:1 to issue checklist.

| Issue test | Coverage |
|---|---|
| Spend limit enforced | Controller `COST_USD=1.0`; first model call records cost 0.99 (succeeds); second call records 0.05 → cumulative 1.04; third call's pre-gate `checkAll()` sees COST_USD over limit → throws `RATE_LIMIT` |
| Action budget decremented | Controller `TURN_COUNT=3`; three model calls succeed; 4th pre-gate sees TURN_COUNT exceeded → throws `RATE_LIMIT` with `variable: "turn_count"` |
| Scope boundary blocks out-of-scope | Backend with `scope:["tool_call"]` → model_call passes gate without evaluator; tool_call gated |
| Policy evaluation deterministic | Stub evaluator; 100 identical requests → 100 identical verdicts |
| Governance events logged | Spy `recordCompliance` receives one record per decision (allow + deny both) |
| Middleware composes correctly | `priority===150`, `name==="koi:governance-core"`, all wrap* + onSessionEnd + describeCapabilities + onBeforeTurn present |

**Additional unit tests:**
- `normalize-usage`: Anthropic cache_creation/cache_read; Bedrock cacheWriteInputTokens; Vertex google fields; unknown provider → zero cache/reasoning; undefined usage → all-zero
- `alert-tracker`: crosses 0.8 once → fires; stays above 0.8 → no re-fire; 0.95 fires independently; cleanup clears set; thresholds pre-sorted
- `cost-calculator`: flat-rate per 1M; unknown model → throws `INVALID_ARGUMENT`; negative tokens → throws
- `config`: missing required fields → `Result.ok:false`; defaults applied; bounds check on thresholds

**Fail-closed tests:**
- Evaluator throws `Error("boom")` → `POLICY_VIOLATION` with `cause.message==="boom"`
- Controller throws → `POLICY_VIOLATION` with cause preserved
- Compliance record throws → gate still denies, warn emitted, no loop

**Stream tests:**
- Gate fires before first yield
- Cost recorded only on `chunk.kind==="done"`
- Early stream error → gate already passed, no cost recorded (documented behavior)

**API surface snapshot:** `__tests__/api-surface.test.ts` freezes exports.

**Coverage target:** ≥80% (bunfig.toml); expect ≥90% given small pure package.

**Golden query (runtime replay, per CLAUDE.md):**
Query `"delete all files"` with backend denying `tool_call` where `toolId==="Bash"`. Expected trajectory: MW span priority 150 → `POLICY_VIOLATION` → model sees deny result → explains refusal. Add to `packages/meta/runtime/scripts/record-cassettes.ts` + trajectory assertions in `golden-replay.test.ts` + two standalone L2 goldens.

---

## 9. Research lifts (attribution & rationale)

| Lift | Source | Rationale |
|---|---|---|
| Fail-closed pattern (throw → deny) | L0 `governance-backend.ts` (existing) | Architecture contract |
| `normalizeUsage()` provider table | [opencode `session.ts:261-322`](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/session/session.ts) | Battle-tested; Anthropic + Bedrock + Vertex cache fields non-obvious |
| Threshold alert dedup per session | v1 `middleware-pay` | Proven UX; avoids double-fire |
| Best-effort compliance record (no block on throw) | v1 `middleware-governance-backend` + CC `PostToolUse` hook | Audit sink must never flip decision |
| Priority 150 | v1 `MIDDLEWARE_PRIORITY = 150` + gap in current chain | Matches prior art |
| `validateConfig` returns `Result<T, E>` | CLAUDE.md "expected failure as value" | Project rule |
| Binary `ok/violations` verdict | L0 `GovernanceVerdict` | Do not introduce ternary without L0 change |
| Budget inheritance as engine responsibility | Hermes anti-pattern (child escapes parent budget) | Avoid Hermes bug; split concerns cleanly |

---

## 10. Out-of-package cross-cuts

- `@koi/runtime`: add dep, new `governance` option, new golden query + trajectory
- `docs/L2/governance-core.md`: user-facing doc (separate commit, pre-code per workflow rule)
- `scripts/layers.ts`: no change — package sits in `packages/security/` L2 tier
- `archive/v1/packages/security/middleware-pay/` + `middleware-governance-backend/`: keep archived; do not merge

---

## 11. Open risks

1. **Controller I/O latency.** `checkAll()` returns `T | Promise<T>` per L0. Any slow backend adds pre-call latency. Mitigation: document in README; recommend in-memory controller for hot path.
2. **Cost calc accuracy.** Flat-rate calculator ignores cached-token discounts. Consumers needing precise costs should provide a custom `CostCalculator`. Out of scope for MVP.
3. **Stream early-exit.** If stream throws between first yield and `done` chunk, gate passed but no cost recorded. Documented behavior; acceptable since partial-stream cost is typically absorbed by provider.
4. **Compliance record for allow decisions.** High volume. Mitigation: `recordCompliance` is opt-in per-backend; backends can sample or batch.

---

## 12. Follow-up issues

- L0 `GovernanceVerdict` ternary (allow/deny/defer) — enables interactive approval
- `@koi/governance-scope`: URL / filesystem / credentials subsystem gating (v1 `scope` port)
- `@koi/governance-budget-inheritance`: wire spawn-depth budget derivation into engine (ties to #1473)
- ARITY table lift from opencode if governance ever scopes bash
