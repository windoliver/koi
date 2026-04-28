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
- Persistent compliance storage — use `@koi/audit-sink-*`

## Ternary verdict — ask flow (gov-11)

`GovernanceVerdict` now supports three outcomes (L0 extension): `{ ok: true }`,
`{ ok: false }`, and `{ ok: "ask", prompt, askId, metadata? }`. An ask verdict
pauses the call and routes an `ApprovalRequest` to the host's `ApprovalHandler`
(e.g., the TUI permission prompt via `TurnContext.requestApproval`).

### Handler resolution and fail-closed

- Missing handler → `KoiRuntimeError.from("PERMISSION", ...)` (deny).
- Handler throws → propagates as deny (fail closed, matches existing rule-level
  contract).
- Timeout → `ApprovalTimeoutError` re-thrown as
  `KoiRuntimeError.from("TIMEOUT", ...)` (distinct from `PERMISSION` so hosts
  catching by error code can distinguish "user took too long" from "user said
  no"). Default `DEFAULT_APPROVAL_TIMEOUT_MS = 60_000`, overridable via
  `GovernanceMiddlewareConfig.approvalTimeoutMs`.

### Decision mapping

`ApprovalDecision` from handler:

| Decision | Behavior |
|----------|----------|
| `allow` | Proceed once; no caching |
| `always-allow` (scope: `session`) | Record session grant keyed by `computeGrantKey(kind, payload)`; subsequent identical asks skip the handler for the rest of the session |
| `always-allow` (scope: `always`) | Same session grant + one-shot `onApprovalPersist(PersistentGrant)` callback for the host to persist |
| `deny` | `KoiRuntimeError.from("PERMISSION", ...)` — turn fails |
| `modify` | Not yet implemented — denied for now (follow-up will rewrite the request payload before proceeding) |

### Inflight coalescing and session lifecycle

- Duplicate asks within a session (same `askId`) coalesce: the first creator
  awaits the handler, other callers await the same promise. Only the creator
  fires `onApprovalPersist` on `always-allow` permanent — downstream waiters
  are idempotent.
- `onSessionEnd` aborts every pending ask via a per-session `AbortController`
  and drops the session's grant set, so leaked promises can't outlive the
  turn.

### AskId brand and type guard

New L0 additions (`@koi/core`):

- `AskId` — branded string (`string & { [__askIdBrand]: "AskId" }`). Construct
  with `askId(id: string): AskId`.
- `isAskVerdict(v): v is Extract<GovernanceVerdict, { ok: "ask" }>` — narrow
  verdicts in backend adapters and tests.

Backends generate ask IDs however they like (deterministic hash, UUID, etc.) —
the middleware treats them opaquely for coalescing only.

### Config additions

```ts
createGovernanceMiddleware({
  backend, controller, cost,
  approvalTimeoutMs: 30_000,             // optional, default 60s
  onApprovalPersist: (grant) => { /* persist PersistentGrant */ },
});
```

`PersistentGrant` shape: `{ kind, agentId, sessionId, payload, grantKey,
grantedAt }`. The type itself now lives in `@koi/core` (L0) and is re-exported
from `@koi/governance-core` for backwards compatibility. `grantKey` is a
deterministic SHA-256 of canonicalized `{kind,payload}` produced by the L0u
helper `computeGrantKey` exported from `@koi/hash` — hosts can use it as a
stable storage key without re-hashing.

A separate L2 package, `@koi/governance-approval-tiers`, is the recommended
backend for `onApprovalPersist`: it appends grants as JSON-Lines to
`~/.koi/approvals.json`, short-circuits subsequent `ok:"ask"` verdicts to
allow on a cached match, and emits `approval.persisted` info-violations into
the host's audit channel.

### Architectural note — why the middleware owns ask routing

Koi has one interposition layer (`KoiMiddleware`); adding a parallel
`EngineHooks` channel for asks would violate that invariant and split verdict
handling across two surfaces. TUI/CLI hosts surface asks through the existing
`TurnContext.requestApproval` primitive — no new L0 contract is required.

## Per-variable alert thresholds (gov-9)

By default, `alertThresholds` (e.g., `[0.8, 0.95]`) applies uniformly to every
sensor. For finer control, pass `perVariableThresholds`:

```typescript
createGovernanceMiddleware({
  controller, backend, cost,
  alertThresholds: [0.8, 0.95],          // global default
  perVariableThresholds: {
    cost_usd: [0.5, 0.75, 0.95],         // override for cost only
    error_rate: [0.3, 0.5],              // earlier alerts on errors
  },
  onAlert: (pct, variable, reading) => { /* … */ },
});
```

The `perVariableThresholds` field is added to `GovernanceMiddlewareConfig`
(see `packages/security/governance-core/src/config.ts`). Validation is
performed by `validateGovernanceConfig` and rejects values outside `(0, 1]`
or non-array entries.

Lookup order: `perVariableThresholds[reading.name]` → `alertThresholds`. The
`@koi/governance-core` alert tracker dedups per `(sessionId, variable, threshold)`,
so adding more thresholds for one variable does NOT re-fire global ones.

## Internal: session abort controller map

`ensureSessionAbort` uses an early-return pattern (rather than `let ctrl`) so
TypeScript's control-flow narrowing correctly infers `AbortController` (not
`AbortController | undefined`) at the return site. No behaviour change.
