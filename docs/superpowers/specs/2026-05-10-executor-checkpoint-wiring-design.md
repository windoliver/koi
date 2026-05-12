# Executor CheckpointStore Wiring — Design

**Date:** 2026-05-10
**Issue:** #1301 Part 2
**Stacked on:** PR #2177 (introduced `CompositionCheckpointStore`)

## Goal

Wire the existing `CompositionCheckpointStore` into `createCompositionExecutor` so each plan execution emits per-step progress snapshots. Snapshots give hosts plan-level orchestration visibility (which executions are in flight, which step is next, what the prior step returned) without changing the existing executionLog correctness contract.

## Non-goals

- **Replacing the executionLog.** The mandatory `executionLog` (per-side-effect claim/record/release) remains the single source of truth for "did this side effect already commit?". CheckpointStore is additive observability + orchestration anchor.
- **Automatic resume.** The executor does not consult the snapshot to skip steps. Resume continues to work via `executionLog.claim() === "complete"` on every restart-time call to `execute()`. Snapshots tell the *host* which executions to retry; once the host calls `execute()` again, normal claim-based short-circuit handles the actual fast-path.
- **Plan-binding enforcement.** If a stored snapshot's `planHash` mismatches the current plan, the executor logs/discards but does not fail the call. Plan-binding decisions are the host's responsibility.

## Surface

`CompositionExecutionContext` gains three optional fields:

```typescript
readonly checkpointStore?: CompositionCheckpointStore | undefined;
/**
 * Required when checkpointStore is wired. Stable per logical execution —
 * hosts typically derive from `${agentId}:${trigger.id}:${trigger.emittedAt}`
 * or a workflow ID for Temporal-backed deployments.
 */
readonly executionId?: string | undefined;
/**
 * Plan-stable hash. Defaults to a SHA-256 of the canonicalized plan
 * (same canonicalize as the executionLog key derivation, so two plans
 * that produce identical step sequences hash identically regardless of
 * field ordering).
 */
readonly hashPlan?: ((plan: CompositionPlan) => string) | undefined;
```

Validation: if `checkpointStore` is provided and `executionId` is missing or empty, the executor returns `INVALID_PLAN` immediately (configuration error — fail fast at the type boundary would be ideal, but executionId is per-execution context so it has to be runtime-checked). Without `checkpointStore`, both other fields are ignored.

## Behavior

After each **successful** step (executed or short-circuited via `claim.kind === "complete"`), the executor calls:

```typescript
await store.save({
  executionId,
  planHash: hashPlan(plan),
  nextStepIndex: stepResults.length,   // already incremented for this step
  stepResults: stepResults.map(r => r.output),  // raw outputs only
  phase: "in_progress",
  savedAt: now(),
});
```

`stepResults` in the snapshot is the **raw outputs** array (not the full `CompositionStepResult` discriminated-union shape) so the snapshot stays compact and the existing checkpoint encoder can sanitize unknown values. The executor does not store the steps themselves (those are recoverable from `plan.steps[0..nextStepIndex-1]` if the host needs them).

On **terminal success** (`status: "executed"` after the loop completes), the executor calls `store.delete(executionId)`.

On **terminal failure / unsupported** (loop returns early via `failedResult` or `unsupportedResult`), the executor calls one final `store.save({ ..., phase: "failed", nextStepIndex: stepResults.length })` so operators can see where execution stopped. The `failed` phase tells the host this snapshot is informational — the next `execute()` call will re-walk the plan with executionLog short-circuiting.

## Error handling

All `store.save` / `store.delete` calls are wrapped in `try { ... } catch { /* observability-only */ }`. CheckpointStore failures must NEVER convert a structured executor result into an uncaught throw — same policy as `outcomeRecorder`.

The encoder may throw on non-serializable step outputs. That throw is also swallowed (snapshot skipped) — the executor does not abort the plan because a snapshot couldn't be stored.

## Default planHash

Default uses `createHash("sha256").update(JSON.stringify(canonicalize(plan))).digest("hex")` — same `canonicalize` already used for step idempotency keys. Keeps the dependency surface zero (re-uses existing helper, `node:crypto` already imported).

## Test coverage

- Snapshot saved after each step (mock store records calls)
- Snapshot deleted on full success
- Snapshot persisted with `phase: "failed"` on terminal failure
- Snapshot persisted with `phase: "failed"` on unsupported step
- `planHash` stable across logically-equivalent plans (field-order independent)
- `store.save` failure is silent (executor still returns structured result)
- Encoder failure on non-serializable output is silent
- Without `checkpointStore`: executor behavior byte-identical to current
- Without `executionId` but with `checkpointStore`: `INVALID_PLAN` returned
- Resume: re-call `execute()` after partial completion; executionLog short-circuits each completed step; final snapshot reflects full completion and is deleted

## Out of scope (follow-ups)

- Temporal-backed `createTemporalCheckpointStore` (next slice)
- SQLite-backed `createSqliteCheckpointStore`
- Plan-binding enforcement (executor discards stale snapshots — host policy)
- Automatic snapshot-driven resume (executionLog already provides correct resume)
