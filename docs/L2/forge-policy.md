# @koi/forge-policy

Forge-specific policy enforcement (L2). Issue #1349.

Sync, deterministic evaluator that gates `ForgeCandidate`s before synthesis.
The L0 `ForgePolicy` interface lives in `@koi/core`; this package wraps it
with the operator-facing knobs the v2 forge pipeline needs (artifact
complexity ceiling, namespace allow/deny, explicit override) and a
tamper-evident audit log of every decision.

**Scope: candidate-time gating, not runtime enforcement.** A `deny` verdict
prevents a candidate from entering the forge pipeline; it does NOT revoke a
brick that has already been published. Post-publication retirement lives
with `@koi/forge-optimizer` (#1350) and `@koi/forge-exaptation` (#1351).

## Surface (exact `src/index.ts` exports)

- `evaluatePolicy(candidate, config, options?): PolicyEvaluation` — pure,
  synchronous evaluator. Runs cheapest checks first (allowed kinds →
  forbidden namespace → max complexity → scope ceiling → approval
  threshold). The first failing check produces the verdict; remaining
  checks are not evaluated. Deterministic: same inputs always produce the
  same verdict. Returns `{ verdict, baseVerdict, overrideApplied }` so an
  audit caller can record both the post-override verdict (the one to act
  on) and the pre-override `baseVerdict` (what was actually bypassed).
  Fails closed (`deny`) when `config.maxComplexity` is set but
  `options.spec` is missing, and when `spec` cannot be canonicalized
  (cycle, `BigInt`, function, or `Symbol`).
- `ForgePolicyConfig` — operator-tunable rules. Extends L0 `ForgePolicy`
  with two L2-only fields:
  - `maxComplexity?: number` — reject candidates whose
    `spec`-derived complexity score exceeds this ceiling. The default
    metric is the **UTF-8 byte length** of a canonical (sorted-keys) JSON
    serialization, so multi-byte Unicode is counted accurately. Omit to
    skip the check; when set, the caller MUST supply `options.spec` or
    the call fails closed. **`spec` must be plain JSON-safe data** — the
    evaluator validates without invoking any user code (getters, setters,
    `toJSON`, custom prototypes such as `Date` / `Map` / class instances,
    `BigInt`, function, and `symbol` values are rejected). Pre-serialize
    such fields before handing the spec to the policy gate.
  - `forbiddenNamespaces?: readonly string[]` — reject candidates whose
    `name` starts with any listed prefix. Use to wall off reserved names
    (`system.`, `koi.`, `internal.`). Matched as case-sensitive prefix.
- `EvaluatePolicyOptions` — per-call inputs:
  - `override?: PolicyOverride` — explicit operator override. When present
    AND `override.granted === true`, a verdict that would have been `deny`
    or `require-approval` is rewritten to `allow` and the override is
    recorded in the audit log. Override never escalates an `allow` to a
    stricter verdict.
  - `complexityOf?: (spec) => number` — caller-supplied complexity metric
    that replaces the default JSON-byte heuristic. Returned values that
    are not finite non-negative numbers are treated as `0`.
- `PolicyOverride` — `{ readonly granted: boolean; readonly reason: string;
  readonly grantedBy: string }`. `granted: false` is recorded but does NOT
  override; an override without `reason` or `grantedBy` is rejected at
  audit time (see `createPolicyAuditLog.record`).
- `createPolicyAuditLog(options?): PolicyAuditLog` — append-only in-memory
  log of decisions. `record(entry)` validates the entry and appends a
  frozen copy; `entries()` returns a frozen snapshot of all recorded
  decisions in insertion order; `size()` returns the count. The log is
  bounded by `options.maxEntries` (default `10_000`) — once the cap is
  reached, the oldest entry is dropped (FIFO) so a long-running session
  cannot exhaust memory.
- `PolicyAuditEntry` — `{ candidateId, verdict, baseVerdict,
  evaluatedAt, override?, configFingerprint }`. `verdict` is the
  post-override decision (what the caller acted on); `baseVerdict` is the
  pre-override decision (what was bypassed when an override was granted).
  When no override is applied the two are equal. `configFingerprint` is
  a stable hash of the config inputs that produced the verdict so a
  forensic reader can tell which policy version made the decision.

## Why these knobs

| Issue requirement | Surface |
|---|---|
| Max artifact complexity | `ForgePolicyConfig.maxComplexity` + `EvaluatePolicyOptions.complexityOf` |
| Allowed capabilities | `ForgePolicy.allowedKinds` (already in L0) |
| Namespace restrictions | `ForgePolicyConfig.forbiddenNamespaces` |
| Policy override controls | `EvaluatePolicyOptions.override` + `PolicyOverride` |
| Policy audit logging | `createPolicyAuditLog` + `PolicyAuditEntry` |
| Sync + deterministic | `evaluatePolicy` returns synchronously, no I/O, no `Date.now()` reads |

## Wiring

L2: depends on `@koi/core` (L0) and `@koi/forge-types` (L0u). No imports
from `@koi/engine` or peer L2 packages. Operators construct a
`ForgePolicyConfig`, optionally an audit log, and call `evaluatePolicy`
from whichever orchestrator owns candidate intake (e.g. a forge tool, a
governance middleware, or `@koi/forge-verifier`).

## Out of scope

- Forge usage tracking, drift detection, mutation pressure, reverification
  queue (v1 had these in `@koi/forge-policy`; in v2 they belong to other
  packages: `@koi/forge-optimizer` for retirement signals,
  `@koi/forge-exaptation` for purpose drift).
- Persistent audit log storage. The in-memory log is intended for a single
  session; a durable adapter is the operator's responsibility.
- Cryptographic signing of audit entries. The fingerprint is a fast hash
  for forensic correlation, not an attestation.
- Capability-vector or ReBAC permission checks (those live with
  `@koi/middleware-permissions`).
- Re-evaluation triggers when a published brick changes (that is forge
  optimizer / exaptation territory).

## Invariants

- `evaluatePolicy` is pure: no clocks, no random, no I/O. Same inputs →
  same verdict.
- An override may only relax a verdict (`deny`/`require-approval` →
  `allow`); it cannot tighten it.
- Audit entries are deep-frozen and stored in insertion order.
- The audit log fails closed: an entry missing required fields throws
  rather than silently dropping the record.
- The complexity heuristic operates on a normalized JSON serialization so
  insertion order of `spec` keys does not affect the score.
- The fingerprint is stable across re-orderings of `allowedKinds` and
  `forbiddenNamespaces` (sorted before hashing) so semantically equal
  configs produce equal fingerprints.
