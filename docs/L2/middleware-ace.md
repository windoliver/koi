# @koi/middleware-ace — Adaptive Continuous Enhancement

Records per-session model/tool trajectories, consolidates them into versioned
playbooks, and injects high-confidence strategies into future model calls so the
agent self-improves across sessions.

This package tracks issue [#1715](https://github.com/windoliver/koi/issues/1715).
It lands incrementally. The package now includes the shipped ACE middleware
integration plus the core **stat pipeline + injection + promotion-gate**
primitives. The remaining future work is the LLM reflector/curator pipeline,
`ace_reflect`, and broader store/runtime extensions.

---

## Why It Exists

Without ACE, agents repeat the same mistakes across sessions: the lesson learned
in session 1 ("always check file existence before editing") doesn't carry into
session 10. ACE closes the loop:

1. **Trajectory recording** — every model/tool call produces a compact
   `TrajectoryEntry` (kind, identifier, outcome, durationMs).
2. **Stat consolidation** — entries aggregate into per-identifier
   `AggregatedStats`, scored by `frequency × successRate × recency_decay`, and
   written through to a `Playbook` via EMA blending.
3. **Injection** — at the start of each model call, the top playbooks (by
   confidence, within a token budget) are prepended as an `[Active Playbooks]`
   system message.

The stat pipeline ships first because it requires no LLM and no extra storage
backend. It is sufficient on its own to surface persistent tool-failure
patterns; the LLM pipeline layered on top adds bullet-level credit assignment
later.

---

## Architecture

L2 feature package. Imports only from L0 (`@koi/core`) and L0u
(`@koi/ace-types`, `@koi/token-estimator`).

```
TrajectoryEntry[] ── aggregateTrajectoryStats ──▶ Map<id, AggregatedStats>
                                                    │
                                                    ▼
                          curateTrajectorySummary (score + filter + sort)
                                                    │
                                                    ▼
                          createDefaultConsolidator (EMA blend, version++)
                                                    │
                                                    ▼
                                              Playbook[]
                                                    │
                            selectPlaybooks (token budget, confidence-greedy)
                                                    │
                                                    ▼
                          formatActivePlaybooksMessage → system prompt
```

The stat/injection/promotion-gate helpers remain pure orchestration surfaces.
`ace-middleware.ts` is the shipped runtime wrapper that owns session state,
clock access, and lifecycle wiring around those helpers.

---

## Public Surface

| Module | Function | Purpose |
|--------|----------|---------|
| `scoring` | `computeRecencyFactor(lastSeen, now, λ)` | `exp(-λ × daysSince)` |
| `scoring` | `computeCurationScore(stats, sessionCount, now, λ)` | `min(1, freq × successRate × recency)` |
| `stats-aggregator` | `aggregateTrajectoryStats(entries)` | Reduce entries → per-identifier stats |
| `stats-aggregator` | `curateTrajectorySummary(stats, sessions, opts)` | Score, filter by `minScore`, sort desc |
| `consolidator` | `createDefaultConsolidator(opts)` | EMA blend new candidates into existing playbooks; bumps `version` and `sessionCount` |
| `injector` | `selectPlaybooks(playbooks, opts)` | Confidence-greedy selection within `maxTokens` |
| `injector` | `formatActivePlaybooksMessage(selected)` | Render selected playbooks into `[Active Playbooks]` system text |
| `promotion-gate` | `evaluatePromotion(proposal, evaluation, thresholds)` | Pure AGP decision: `promote` / `reject` / `rollback` |
| `promotion-gate` | `commitPromotion(deps, proposal, evaluation, thresholds)` | Save a promoted structured-playbook head with version bump + provenance |
| `promotion-gate` | `rollbackPromotion(deps, proposal, targetVersion, evaluation)` | Restore an earlier structured-playbook snapshot as a new head |

---

## Versioning & Provenance

Every consolidated playbook carries a monotonic `version` (bumped on each
mutation) and an optional `provenance` field linking back to the source
trajectory window, proposal, and evaluation that produced the commit. The
default consolidator bumps `version` but does **not** populate `provenance` —
that is the responsibility of the promotion gate. `commitPromotion(...)`
records accepted evaluations and saves a new head only when thresholds pass
(AGP "no evidence, no commit"). `rollbackPromotion(...)` requires store lineage
support via `StructuredPlaybookStore.getVersion(...)` and restores a chosen
prior snapshot as a fresh head with a new version and rollback provenance.

---

## Manifest Schema

Issue [#2088](https://github.com/windoliver/koi/issues/2088) introduces an opt-in
`ace:` block in `koi.yaml`. Activation is **TUI-host only** — `koi start`
continues to reject `ace.enabled: true` (single-shot prompts have no
session loop to record into).

```yaml
ace:
  enabled: true                          # boolean — required to opt in
  acknowledge_cross_session_state: true  # required when enabled: true (see below)
  max_injected_tokens: 800               # >0; maps to AceConfig.maxInjectedTokens
  min_score: 0.05                        # in [0, 1]; maps to AceConfig.minScore
  lambda: 0.05                           # >0; maps to AceConfig.lambda
  playbook_path: ./.koi/ace.db           # optional; manifest-relative, or ":memory:"
```

`enabled: true` requires `acknowledge_cross_session_state: true`. ACE-learned
playbooks persist across `/clear` and `/new` within a TUI process — they
survive conversation resets and are only discarded on process exit. The
double opt-in makes this trade-off explicit at manifest-load time rather
than buried in a startup banner.

### Validation

- Unknown keys are rejected at manifest load (typo guard).
- Numeric ranges are checked at parse time so misconfiguration fails at
  startup, not at the first model call.
- `playbook_path` is resolved at parse time: absolute paths and the
  `:memory:` sentinel pass through verbatim; relative paths are anchored
  against the manifest's directory (NOT the process cwd).
- `enabled: false` (and `ace: {}`) is a valid declarative no-op.

## Enabling in TUI

Set `ace.enabled: true` in your `koi.yaml` and run `koi tui --manifest koi.yaml`.
The TUI builds an `AceConfig` from the manifest fields and wires the ACE
middleware into the runtime via `extraMiddleware`.

### Activation gates

1. **Spawn-stack-excluded gate** — ACE refuses to activate while the `spawn`
   stack is active because spawned children would read the same playbook
   store (per-agent partitioning is future work). The default
   `manifest.stacks` is `undefined`, which means *all* stacks active including
   `spawn` — so opting in requires an explicit `manifest.stacks` list that
   excludes `"spawn"`. The predicate is exported as `isSpawnStackActive` from
   `@koi/cli` for testing. Refusal exits with status 1 and a message naming
   the design-doc reference.

2. **Resume-without-manifest auto-handling** — bare `--resume` (no
   `--manifest`) sets `skipManifestDiscovery`, which bypasses manifest loading
   entirely. The whole `ace:` parse + activation branch never runs, so
   resumed sessions inherit no ACE state from the cwd manifest. This mirrors
   the `audit` resume-handling precedent.

### Store selection

| `playbook_path` | Store | Lifetime |
|----------------|-------|----------|
| unset          | in-memory | lost on process exit; survives `/clear` and `/new` |
| `:memory:`     | sqlite (RAM) | lost on process exit |
| manifest-relative path | `@koi/playbook-store-sqlite` (WAL, foreign keys) | persists across processes |

When a SQLite store is constructed, the TUI registers a `process.on("exit")`
hook that calls `store.close()` so WAL is checkpointed cleanly.

### Cross-session state (why `acknowledge_cross_session_state` is required)

ACE intentionally accumulates learned playbooks across sessions in a single
process — that is how the injection-on-`onSessionStart` loop works. Today the
runtime cycles the session lifecycle on `/clear` and `/new` instead of
recreating the whole runtime, so the `PlaybookStore` survives those resets.
Operators who want a privacy boundary must restart the TUI process (or, with
a SQLite store on disk, delete the file). The `acknowledge_cross_session_state:
true` opt-in makes this trade-off explicit at manifest-load time rather than
buried in a startup banner.

### Host scope

`koi start` continues to reject `ace.enabled: true` at fresh manifest load —
single-shot prompts cannot run the consolidation/injection loop. Resume
paths in `start` likewise inherit `skipManifestDiscovery` semantics.

### Known limitations

- **In-memory trajectory store deliberately omitted.** ACE's `trajectoryStore`
  is left undefined on the TUI activation path. Without a pruning hook, an
  in-memory trajectory store would grow for the life of the process.
  Trajectory consolidation still happens at `onSessionEnd` using the
  in-process working buffer.
- **No spawn support.** ACE and the spawn preset stack are mutually exclusive
  until per-agent partitioning lands.

The full design analysis lives in
`docs/superpowers/specs/2026-04-30-tui-ace-toml-design.md` (10 review rounds
of refinement).

---

## Future Work

| Phase | Adds |
|-------|------|
| Per-agent partitioning | Allow ACE alongside the spawn preset stack |
| `clear()` on `PlaybookStore` | Wire `/clear` and `/new` to reset ACE state in-process |
| LLM pipeline | `reflector` + `curator` + `StructuredPlaybook` operations (`add` / `merge` / `prune`) with bullet credit assignment |
| `ace_reflect` tool | Agent-initiated mid-session reflection |
| `@koi/playbook-store-sqlite` | Cross-process persistence; per-session/per-root-agent partitioning; `clear()` API |
| Golden query | `@koi/runtime` cassette + replay assertion |

---

## References

- v1 archive: `archive/v1/packages/mm/middleware-ace/` (~3.7K LOC)
- v1 types: `archive/v1/packages/lib/ace-types/`
- Closed v1 issues: #89, #480, #1062, #1095, #1164, #1067, #551
- Pairs with #1472 (Decision Trace Infrastructure), #1649 (skill auto-distillation)
