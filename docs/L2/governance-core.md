# @koi/governance-core — Governance Middleware Bundle

L2 middleware that gates every model call and tool call through a pluggable `GovernanceBackend.evaluator` and enforces numeric `GovernanceController` setpoints (token usage, cost, turn count, spawn depth). Records token/cost events after each successful model call and emits best-effort compliance records for audit.

## Position in the middleware chain

- 50 — exfiltration-guard
- 100 — permissions (rule-based tool allow/deny)
- **150 — governance-core (this package)**
- 300 — audit

## Fail-closed contract

- `evaluator.evaluate()` throws → `POLICY_VIOLATION` with `cause` preserved
- `controller.checkAll()` throws → `POLICY_VIOLATION` with `cause`
- `compliance.recordCompliance()` fails → warn and swallow; denial decision is authoritative

## Usage

```ts
createGovernanceMiddleware({
  backend,      // GovernanceBackend (L0)
  controller,   // GovernanceController (L0)
  cost,         // CostCalculator
  alertThresholds: [0.8, 0.95],
  onAlert, onViolation, onUsage,
})
```

## Budget inheritance

Spawn-depth budget inheritance is the engine's responsibility (#1473). Parent records `{kind:"spawn", depth}`; child agents receive a derived `GovernanceController` via `SubsystemToken<GovernanceController>` at assembly time.

## Out of scope

- URL / filesystem / credentials scope subsystem — follow-up package
- Approval / deferral UX (three-tier allow/deny/ask) — requires L0 `GovernanceVerdict` extension
- Persistent compliance storage — use `@koi/audit-sink-*`
