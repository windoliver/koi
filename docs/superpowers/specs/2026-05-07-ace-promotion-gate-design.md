# ACE Promotion Gate Design

**Date:** 2026-05-07  
**Issue:** [#1715](https://github.com/windoliver/koi/issues/1715)  
**Branch scope:** `codex/issue-1715-ace-remaining`

## Summary

This spec scopes the next `#1715` increment to the **evidence-gated promotion
engine** only. The existing ACE stat pipeline, playbook injection, type surface,
and store adapters already exist in v2. What remains missing for safe evolution
is the rule that playbook mutations must be proposed, evaluated, and committed
only when evidence crosses explicit thresholds.

This branch will add a pure promotion engine to `@koi/middleware-ace` that:

- reads `PlaybookProposal` and `PlaybookEvaluation`
- enforces "no evidence, no commit"
- applies reversible `add` / `merge` / `prune` operations to
  `StructuredPlaybook`
- records commit provenance on successful promotion
- performs no-op on rejected evaluations
- supports deterministic rollback to a prior structured-playbook version

This branch will **not** add the reflector, curator LLM prompts, `ace_reflect`,
or new middleware hooks. Those can build on this engine later.

## Why This Slice

This is the highest-leverage unfinished part of `#1715` because the repository
already contains:

- future-facing ACE types in `@koi/ace-types`
- `StructuredPlaybookStore` and `PlaybookProposalStore` persistence contracts
- SQLite and Nexus proposal/evaluation storage adapters
- middleware stat-pipeline behavior for flat playbooks

By landing the promotion gate first, later reflection work can emit proposals
into a safe commit path instead of mutating playbooks directly.

## Goals

1. Provide a reusable promotion engine as a pure library surface in
   `@koi/middleware-ace`.
2. Enforce threshold-based evaluation before any structured playbook mutation.
3. Ensure successful commits carry `sourceTrajectoryRange`, `proposalId`, and
   `evaluationId` provenance.
4. Ensure failed evaluations never silently partially mutate a playbook.
5. Support rollback using version lineage when the backing
   `StructuredPlaybookStore` exposes `getVersion`.
6. Add tests covering one accepted promotion and one rejected promotion.

## Non-Goals

- No LLM reflector implementation
- No curator prompt / operation synthesis
- No `ace_reflect` tool
- No new runtime or middleware activation path
- No automatic promotion from `onSessionEnd`
- No changes to the existing flat `PlaybookStore` stat-pipeline commit path

## Proposed Surface

Add a new module in `packages/lib/middleware-ace/src/`:

- `promotion-gate.ts`

Export a small pure orchestration surface:

```ts
export interface PromotionGateDeps {
  readonly structuredStore: StructuredPlaybookStore;
  readonly proposalStore?: PlaybookProposalStore;
  readonly clock?: () => number;
}

export interface PromotionDecision {
  readonly outcome: "promoted" | "rejected" | "rolled_back";
  readonly playbookId: string;
  readonly proposalId: string;
  readonly evaluationId: string;
  readonly fromVersion: number;
  readonly toVersion: number;
}

export async function evaluatePromotion(
  proposal: PlaybookProposal,
  evaluation: PlaybookEvaluation,
  thresholds: PromotionThresholds,
): Promise<"promote" | "reject" | "rollback">;

export async function commitPromotion(
  deps: PromotionGateDeps,
  proposal: PlaybookProposal,
  evaluation: PlaybookEvaluation,
): Promise<PromotionDecision>;

export async function rollbackPromotion(
  deps: PromotionGateDeps,
  proposal: PlaybookProposal,
  targetVersion: number,
  evaluation: PlaybookEvaluation,
): Promise<PromotionDecision>;
```

`evaluatePromotion()` remains pure and side-effect free. `commitPromotion()` and
`rollbackPromotion()` are store-backed orchestration helpers.

## Decision Rules

### 1. Proposal/evaluation identity checks

Before any commit logic:

- `evaluation.proposalId` must equal `proposal.id`
- `proposal.id`, `proposal.playbookId`, `evaluation.id`, and
  `evaluation.proposalId` must be non-empty
- the target structured playbook must exist
- `proposal.baseVersion` must equal the current structured playbook version

Version mismatch fails closed with a validation error. We do not auto-rebase
operations onto a newer playbook version in this slice.

### 2. Threshold enforcement

Promotion happens only when all of these are true:

- `evaluation.verdict === "promote"`
- `metrics.helpfulRate >= thresholds.minHelpfulRate`
- `metrics.harmfulRate <= thresholds.maxHarmfulRate`
- `metrics.trials >= thresholds.minTrials`
- if `thresholds.maxTokenDelta` is set, then
  `metrics.tokenDelta <= thresholds.maxTokenDelta`

Missing required metrics are treated as insufficient evidence and therefore
reject promotion. This implements "no evidence, no commit."

### 3. Reject path

If threshold evaluation fails or `evaluation.verdict === "reject"`:

- return a `rejected` decision
- do not mutate the structured playbook
- do not write derived rollback state

### 4. Rollback path

If `evaluation.verdict === "rollback"`:

- require `structuredStore.getVersion`
- load `targetVersion`
- require `proposal.playbookId` to match the target playbook
- replace current playbook with that prior version as a new head version
- stamp the new head with provenance from the rollback evaluation

Rollback is explicit and version-granular. If lineage is unavailable, fail
closed with a validation error instead of silently ignoring rollback.

## Playbook Mutation Rules

Operations apply in order against the current structured playbook snapshot.

### `add`

- find or create the named section
- append a new bullet with a generated ID
- initialize `helpful = 0` and `harmful = 0`

### `merge`

- require both bullet IDs to exist
- replace the first bullet's content with merged content
- remove the second bullet
- preserve counters by summing `helpful` and `harmful`

### `prune`

- require the bullet to exist
- remove the bullet from its section
- if a section becomes empty, keep the empty section in this slice

Keeping empty sections avoids hidden structural churn and makes rollback diffs
easier to reason about. A later cleanup pass can decide whether empty-section
compaction is desirable.

## Versioning And Provenance

Every successful promote or rollback writes a new structured-playbook head:

- `version = current.version + 1`
- `updatedAt = clock()`
- `provenance.sourceTrajectoryRange = proposal.sourceTrajectoryRange`
- `provenance.proposalId = proposal.id`
- `provenance.evaluationId = evaluation.id`
- `provenance.committedAt = clock()`

Rollback reuses the rollback-triggering evaluation as the commit provenance for
the restored head. The historical version remains immutable in the underlying
store lineage.

## Error Handling

Fail with explicit validation errors for:

- proposal/evaluation ID mismatch
- missing required metrics for a promote verdict
- base-version mismatch
- target structured playbook not found
- missing bullet IDs for `merge`/`prune`
- rollback requested but store has no lineage support
- rollback target version not found

There is no best-effort partial commit path. Any invalid operation aborts the
entire promotion attempt before persistence.

## Testing

Add focused unit tests under `packages/lib/middleware-ace/src/` covering:

1. accepted promotion:
   - existing structured playbook
   - valid proposal + evaluation + thresholds
   - operations applied
   - version incremented
   - provenance populated

2. rejected promotion:
   - promote verdict but missing or insufficient metrics
   - no mutation occurs

3. rollback:
   - prior version exists
   - rollback creates a new head with restored content

4. validation failures:
   - base-version mismatch
   - missing bullet ID in merge/prune
   - rollback without `getVersion`

This branch only needs the first two to satisfy the tightened `#1715`
acceptance language, but rollback and validation tests are included because they
exercise the invariants that make the gate safe.

## File Plan

Primary files:

- `packages/lib/middleware-ace/src/promotion-gate.ts`
- `packages/lib/middleware-ace/src/promotion-gate.test.ts`
- `packages/lib/middleware-ace/src/index.ts`
- `docs/L2/middleware-ace.md`

Documentation update:

- revise `docs/L2/middleware-ace.md` to distinguish what is already shipped
  (stat pipeline + middleware integration) from what this branch adds
  (promotion gate primitives)

## Risks

### Store-lineage variance

Some `StructuredPlaybookStore` implementations may not expose `getVersion`.
This design handles that by allowing normal promotion without lineage, but
requiring lineage for rollback.

### Metric naming drift

`PlaybookEvaluation.metrics` is a free-form map. This slice standardizes on:

- `helpfulRate`
- `harmfulRate`
- `trials`
- `tokenDelta` (optional)

The promotion gate owns this interpretation so later evaluator producers must
emit these canonical keys.

### Scope creep

It will be tempting to wire the gate into middleware immediately. This spec
explicitly avoids that. The goal is a correct, testable engine first.

## Implementation Follow-Up

After this spec is approved, the implementation plan should keep the work in
three small steps:

1. pure decision logic and tests
2. structured-playbook mutation helpers and tests
3. store-backed commit/rollback orchestration and docs
