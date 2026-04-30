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

## Manifest Schema

Issue [#2088](https://github.com/windoliver/koi/issues/2088) introduces an opt-in
`ace:` block in `koi.yaml`. `koi tui` activates the middleware under the gates
documented below. `koi start` continues to reject `ace.enabled: true` because
ACE is a TUI-only feature (no headless dogfood loop today).

```yaml
ace:
  enabled: true                          # boolean — required to opt in
  acknowledge_cross_session_state: true  # required when enabled: true (see below)
  max_injected_tokens: 800               # >0; maps to AceConfig.maxInjectedTokens
  min_score: 0.05                        # in [0, 1]; maps to AceConfig.minScore
  lambda: 0.05                           # >0; maps to AceConfig.lambda
```

`enabled: true` requires `acknowledge_cross_session_state: true`. ACE-learned
playbooks persist across `/clear` and `/new` within a TUI process — they
survive conversation resets and are only discarded on process exit. The
double opt-in makes this trade-off explicit at manifest-load time rather
than buried in a startup banner.

### Validation

- Unknown keys are rejected at manifest load (typo guard).
- `playbook_path` is rejected with a pointer to the future
  `@koi/playbook-store-sqlite` issue. Schema additions for persistence land
  atomically with their consumer.
- Numeric ranges are checked at parse time so misconfiguration fails at
  startup, not at the first model call.
- `enabled: false` (and `ace: {}`) is a valid declarative no-op.

### Activation in TUI

`koi tui` builds an `AceConfig` from `manifest.ace`, instantiates
`@koi/middleware-ace` with in-memory stores, and threads it through
`createKoiRuntime({ ace })`. Two gates apply:

1. **Spawn-gate.** When `manifest.stacks` is undefined (defaults include
   `spawn`) or explicitly contains `"spawn"`, activation is refused with a
   stderr message and the TUI continues without ACE. The spawn preset stack
   would let child agents inherit the parent middleware instance and
   contaminate the in-memory `PlaybookStore`. Per-agent partitioning is
   tracked as future work alongside `@koi/playbook-store-sqlite`.

   To dogfood ACE today, set an explicit `stacks` list that excludes spawn:

   ```yaml
   stacks:
     - observability
     - checkpoint
     - execution
   ace:
     enabled: true
   ```

2. **Resume-provenance gate.** When `koi tui --resume <id>` is invoked
   without `--manifest`, the host skips manifest auto-discovery (so the
   cwd manifest cannot silently override the original session's
   model/stacks/governance). ACE activation runs inside that block, so a
   resumed session without explicit `--manifest` defaults to ACE off.
   This mirrors the existing `audit` resume-handling pattern.

On successful activation the host writes:

```
koi tui: ace: enabled (in-memory). Learned playbooks persist across
/clear and /new within this process; they are lost on process exit.
Restart the TUI for a privacy boundary.
```

### Known limitations

- **State leaks across `/clear` and `/new`.** ACE intentionally accumulates
  learned playbooks across sessions in a single process — that is how the
  injection-on-`onSessionStart` loop works. Today the runtime cycles the
  session lifecycle on `/clear` and `/new` instead of recreating the whole
  runtime, so the `PlaybookStore` survives. Operators who want a privacy
  boundary must restart the TUI process. A future `clear()` API on
  `PlaybookStore` (and hooks into reset) is tracked alongside the sqlite
  follow-up.
- **In-memory trajectory store deliberately omitted.** ACE's
  `trajectoryStore` is left undefined on the TUI activation path. Without
  a pruning hook, an in-memory trajectory store would grow for the life of
  the process. Trajectory consolidation still happens at `onSessionEnd`
  using the in-process working buffer; persistent trajectory storage lands
  with `@koi/playbook-store-sqlite`.
- **No cross-process persistence.** Requires `@koi/playbook-store-sqlite`
  (issue [#2087](https://github.com/windoliver/koi/issues/2087)).
- **No spawn support.** ACE and the spawn preset stack are mutually
  exclusive until per-agent partitioning lands.

The full design analysis lives in
`docs/superpowers/specs/2026-04-30-tui-ace-toml-design.md` (10 review rounds
of refinement).

---

## Future Work

| Phase | Adds |
|-------|------|
| Per-agent partitioning | Allow ACE alongside the spawn preset stack |
| `clear()` on `PlaybookStore` | Wire `/clear` and `/new` to reset ACE state in-process |
| Middleware integration | `KoiMiddleware` with `wrapModelCall` (inject) + `wrapToolCall` (record) + `onSessionEnd` (consolidate) |
| LLM pipeline | `reflector` + `curator` + `StructuredPlaybook` operations (`add` / `merge` / `prune`) with bullet credit assignment |
| Promotion gate | Proposal → evaluation → commit/rollback flow; `PlaybookProposalStore` lineage |
| `ace_reflect` tool | Agent-initiated mid-session reflection |
| `@koi/playbook-store-sqlite` | Cross-process persistence; per-session/per-root-agent partitioning; `clear()` API |
| Golden query | `@koi/runtime` cassette + replay assertion |

---

## References

- v1 archive: `archive/v1/packages/mm/middleware-ace/` (~3.7K LOC)
- v1 types: `archive/v1/packages/lib/ace-types/`
- Closed v1 issues: #89, #480, #1062, #1095, #1164, #1067, #551
- Pairs with #1472 (Decision Trace Infrastructure), #1649 (skill auto-distillation)
