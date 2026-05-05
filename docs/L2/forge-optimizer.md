# @koi/forge-optimizer

Advisory artifact-optimization helpers for forged bricks (L2). Issue #1350.

**Scope: advisory only.** Every function here returns a *suggestion* or a
*validation result*. Nothing in this package mutates a `ForgeStore`, deletes
an artifact, or performs lifecycle transitions on its own. Auto-removal is
explicitly out of scope — the caller (CLI, dashboard, governance middleware)
decides whether to act.

This v2 package replaces v1's `forge-optimizer` (993 LOC, A/B-evaluated
crystallized composites and auto-deprecated underperformers). v2 narrows
scope per `.claude/plans/v2-rewrite.md`: surface usage + performance signals
and propose actions; never act.

## Surface (exact `src/index.ts` exports)

### Usage tracking

- `recordUsage(fitness, event, ingestNow): BrickFitnessMetrics` — pure
  update of a `BrickFitnessMetrics` value. Increments `successCount` or
  `errorCount`, advances `lastUsedAt`, and pushes the latency sample into
  the bounded buffer (oldest dropped at `cap`). Never mutates the input.
  `ingestNow` is the caller-supplied wall-clock ceiling: `event.at` is
  clamped against it so a skewed/future timestamp cannot poison recency,
  and the same `(event, ingestNow)` pair always produces the same
  `lastUsedAt` (deterministic — safe to replay). After clamping, recency
  advances monotonically. Throws `TypeError` if `event.at` or `ingestNow`
  is non-finite (fail-loudly contract: a malformed timestamp must not
  silently corrupt stored recency state).
- `UsageEvent` — `{ outcome: "success" | "error"; latencyMs: number; at: number }`.

### Performance scoring

- `computePerformanceScore(fitness, now, options?): number` — non-negative
  score derived from success rate, average latency, and recency. Higher is
  better. Returns `0` when the brick has zero invocations. Mirrors the v1
  fitness formula but operates only on L0 types.
- `PerformanceScoreOptions` — `{ evaluationWindowMs?: number }`. Default
  window is 7 days; recency factor halves every window.

### Lifecycle transitions

Two explicitly-named APIs so callers cannot accidentally preflight against
the wrong rule set:

- `validateGraphTransition(from, to): LifecycleTransitionResult` —
  validates against L0 `VALID_LIFECYCLE_TRANSITIONS` only. Use for
  in-memory state-machine reasoning where the store is not involved.
  Rejects skip states (e.g., `draft → active` without `verifying`),
  unknown values, and identity edges.
- `validateStoreTransition(from, to): LifecycleTransitionResult` — applies
  the L0 graph rules AND additionally rejects any transition out of a
  lifecycle the content-addressable store treats as terminal (`failed`,
  `deprecated`, `quarantined`). Use when preflighting a store `update()`
  so the helper and the store agree on what can persist.

Both return the discriminated union
`{ ok: true } | { ok: false; reason: string }`.

### Optimization suggestions

- `suggestMerge(bricks): readonly MergeSuggestion[]` — groups artifacts by
  `(kind, normalized name, normalized description)` and proposes a merge
  when two or more artifacts collide. Similarity is exact-match on a
  normalized form (lowercase, whitespace-collapsed); intentionally
  conservative — false positives waste reviewer time.
- `suggestSimplify(brick): SimplifySuggestion | undefined` — fires only for
  composite artifacts whose pipeline can collapse (single step, or input
  port equal to output port). Returns `undefined` for non-composites.

### Retirement policy

- `suggestRetirement(bricks, policy, now?): readonly RetirementSuggestion[]`
  — returns suggestions per `active` brick. Each suggestion carries a
  `kind` discriminator:
  - `kind: "retire"` — usage / idle / success-rate threshold violated.
    Safe for callers that auto-apply retirement actions.
  - `kind: "integrity"` — telemetry corruption (non-finite `lastUsedAt`,
    `NaN`/`Infinity` counters). Operators should investigate, NOT
    auto-retire — observability failures must not deprecate active bricks.
  Bricks not currently `active` are skipped — retirement only narrows from
  `active`. Throws `TypeError` on malformed `policy` (NaN/negative
  thresholds, success rate outside `[0, 1]`) or non-finite `now`.
- `RetirementPolicy` — `{ minUsageCount; maxIdleMs; minSuccessRate?;
  minSampleSize? }`.

## Non-goals (intentional)

- **No store mutation.** Never calls `ForgeStore.update` or
  `ForgeStore.remove`. v1 auto-deprecated bricks; v2 must not, per the
  issue's "Optimization is advisory" agent instruction.
- **No A/B comparison against component tools.** v1's composite-vs-components
  comparison required walking provenance (`ngramKey`); v2 defers that to a
  future package once provenance schemas stabilise.
- **No policy promotion.** v1 promoted 100%-success bricks to "policy mode"
  short-circuiting model calls; v2 has no equivalent governance hook yet.
- **No cross-agent invalidation.** v1 wired `StoreChangeNotifier`; v2 leaves
  that to the caller that owns the action.

## Lifecycle (architecture invariant, from L0)

`VALID_LIFECYCLE_TRANSITIONS`:

```
draft       → verifying | failed
verifying   → active     | failed
active      → deprecated | quarantined
deprecated  → quarantined
quarantined → draft
failed      → (terminal)
```

`validateGraphTransition` / `validateStoreTransition` are the enforcement points in this
package. Transitions outside this table — including skip states like
`draft → active` — are rejected.

## Tests

Each module has a colocated `*.test.ts`. Coverage threshold is the repo-wide
80% (lines / functions / statements, enforced in `bunfig.toml`).
