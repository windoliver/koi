# @koi/middleware-ace — Adaptive Continuous Enhancement

Records per-session model/tool trajectories, consolidates them into versioned
playbooks, and injects high-confidence strategies into future model calls so the
agent self-improves across sessions.

This package tracks issue [#1715](https://github.com/windoliver/koi/issues/1715).
It lands incrementally: this revision ships the **stat pipeline + injection
primitives** as pure functions. Middleware integration, the LLM
reflector/curator, and the AGP-derived promotion gate land in subsequent PRs.

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

Every step is a pure function. A future `ace-middleware.ts` will own state and
clock, calling these primitives.

---

## Public Surface (this revision)

| Module | Function | Purpose |
|--------|----------|---------|
| `scoring` | `computeRecencyFactor(lastSeen, now, λ)` | `exp(-λ × daysSince)` |
| `scoring` | `computeCurationScore(stats, sessionCount, now, λ)` | `min(1, freq × successRate × recency)` |
| `stats-aggregator` | `aggregateTrajectoryStats(entries)` | Reduce entries → per-identifier stats |
| `stats-aggregator` | `curateTrajectorySummary(stats, sessions, opts)` | Score, filter by `minScore`, sort desc |
| `consolidator` | `createDefaultConsolidator(opts)` | EMA blend new candidates into existing playbooks; bumps `version` and `sessionCount` |
| `injector` | `selectPlaybooks(playbooks, opts)` | Confidence-greedy selection within `maxTokens` |
| `injector` | `formatActivePlaybooksMessage(selected)` | Render selected playbooks into `[Active Playbooks]` system text |

---

## Versioning & Provenance

Every consolidated playbook carries a monotonic `version` (bumped on each
mutation) and an optional `provenance` field linking back to the source
trajectory window, proposal, and evaluation that produced the commit. The
default consolidator bumps `version` but does **not** populate `provenance` —
that is the responsibility of the (future) promotion gate, which only commits
proposals that pass evaluation thresholds (AGP "no evidence, no commit"
constraint, see #1715 design notes).

---

## Future Work

| Phase | Adds |
|-------|------|
| Middleware integration | `KoiMiddleware` with `wrapModelCall` (inject) + `wrapToolCall` (record) + `onSessionEnd` (consolidate) |
| LLM pipeline | `reflector` + `curator` + `StructuredPlaybook` operations (`add` / `merge` / `prune`) with bullet credit assignment |
| Promotion gate | Proposal → evaluation → commit/rollback flow; `PlaybookProposalStore` lineage |
| `ace_reflect` tool | Agent-initiated mid-session reflection |
| Golden query | `@koi/runtime` cassette + replay assertion |

---

## References

- v1 archive: `archive/v1/packages/mm/middleware-ace/` (~3.7K LOC)
- v1 types: `archive/v1/packages/lib/ace-types/`
- Closed v1 issues: #89, #480, #1062, #1095, #1164, #1067, #551
- Pairs with #1472 (Decision Trace Infrastructure), #1649 (skill auto-distillation)
