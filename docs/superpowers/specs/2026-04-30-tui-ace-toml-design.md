# Issue #2088 — Implementation analysis (10 review rounds)

**Issue:** [#2088](https://github.com/windoliver/koi/issues/2088) — **recommended status: implementable; sketch in section "Design that lands #2088 today" below**
**Depends on:** [#1715](https://github.com/windoliver/koi/issues/1715) (PR [#2086](https://github.com/windoliver/koi/pull/2086) merged 2026-04-30 — ships `@koi/ace-types` + `@koi/middleware-ace` stat-pipeline surface)
**Date:** 2026-04-30
**Status:** Analysis document recommending implementation. The actual implementation should be done in a fresh branch following the sketch below.

## TL;DR

Ten rounds of adversarial review on this issue iteratively narrowed the scope under increasingly strict safety claims, only to walk back most of those claims in round 10 when checked against the codebase's actual trust model. The corrected conclusion: **issue #2088 is implementable today** with a small, well-bounded design that gates ACE activation on `manifest.stacks` excluding the `spawn` preset stack and mirrors the existing `audit` resume-handling pattern. No new env gates, CLI flags, sqlite store, store-API changes, or partitioning are prerequisites for the dogfood loop the issue describes.

The branch this analysis is committed on (`feat/tui-ace-toml`) should be merged as a docs-only analysis PR (or its content moved to the implementation PR's description); see "Recommended next steps" for branch handling. The actual implementation belongs in a fresh branch following the design sketch below.

## How we got here

Issue #2088 frames the work as cheap dogfood plumbing: "the runtime config field already exists; just have the TUI set it." Each review round surfaced a constraint that ate into that premise:

| Round | Constraint surfaced | Effect on scope |
|---|---|---|
| 1 | `createKoiRuntime` doesn't take manifest objects; `koi start` shares the loader and needs explicit host-scope handling; cross-session state has no isolation story | Plumbing path expands; host fork needed; reset semantics needed |
| 2 | Reset hook can't be cleanly inserted around `cycleSession()`; in-memory store has no `clear()` API; spawn/child-agent contamination risk | Reset hooks dropped; lifecycle limits documented |
| 3 | Repo-controlled `koi.yaml` enabling prompt-shaping middleware is a trust regression (matches existing `manifest.audit` env-gate precedent); shared store under spawn-active TUI = unrecoverable contamination | Operator env gate added; spawn-disable added |
| 4 | Operator escape hatch (`koi tui --no-spawn`) doesn't exist; session picker switches use `resetSessionState({ truncate: false })` so contamination spans more than just `/clear` and `/new` | Activation deferred entirely; PR retargeted as "plumbing only" |
| 5 | "Plumbing only" still ships an inert config surface that can be silently misread as activation; "does not close #2088" guarantee depends on PR mechanics | Stderr-warning matrix added; PR mechanics documented |
| 6 | "Parse but ignore" is weaker than the repo's existing fail-closed posture (`backgroundSubprocesses`, `audit`); "forward-compatible" claim conflicts with strict-reject policy | Hard-reject `enabled: true` at manifest load; forward-compat claim dropped |
| 7 | Resume paths (`tui-command.ts:1083-1087`, `start.ts:390-395`) skip cwd manifest auto-discovery so the "universal" rejection isn't universal; shipping the inert schema breaks older binaries with zero feature payoff | This decision doc replaces the implementation spec |

Each round's resolution was correct in isolation, but the cumulative effect is a PR with no shippable feature: the safest scope (schema-only, hard-reject `enabled: true`) only delivers a config field nobody can use, while introducing a real version-skew regression for older binaries that would now hard-fail on a known schema entry.

## Re-analysis (round 10): no hard blockers remain

Rounds 1-9 produced an iteratively narrower scope and a growing list of "blockers." Round 10 dismantled most of them by checking each claimed blocker against the codebase's actual trust model and the existing manifest surface. The corrected analysis: **issue #2088 is implementable today** with a small, well-bounded design. None of the items previously called blockers actually meet that bar.

### Items previously called blockers (now: not blockers)

- **CLI `--no-spawn` flag** — not needed. `ManifestConfig.stacks` already accepts an explicit subset (or empty array), and the TUI honors it during stack activation. The activation PR can require operators who want ACE to set `manifest.stacks` to a list that excludes `spawn`. A dedicated CLI flag is a UX nicety to add later if telemetry shows the manifest path is too friction-y.
- **Operator env-gate (`KOI_ACE_DOGFOOD=1` or similar)** — not justified by the existing trust model. The codebase already lets repo-controlled `koi.yaml` set the entire system prompt via `manifest.instructions`, choose middleware via `manifest.middleware`, and shape stack composition via `manifest.stacks`. ACE prepending `[Active Playbooks]` is strictly less invasive than `manifest.instructions` (which can replace the prompt outright). The `manifest.audit` env-gate that earlier rounds cited as precedent is about file-sink path containment (writing to disk paths the user didn't intend), not prompt shaping. Adding an ACE-specific env gate would be a one-off policy with no codebase precedent and would set a confusing standard.
- **Per-session / per-root-agent partitioning** — not a hard blocker if the activation PR fails closed when the `spawn` preset stack is active. Without spawn, there are no child agents and no `task_delegate` calls, so the contamination path the partitioning would protect against is unreachable. Partitioning becomes a real prerequisite only for a *future* PR that wants ACE to work alongside spawn — which is not what #2088 asks for.

### Real residual concerns (acknowledge in the activation PR; not blocking)

- **Resume-path manifest re-validation has a broader gap.** `readSessionMeta()` (in `shared-wiring.ts`) returns `{}` for absent, unreadable, or malformed `.koi-meta.json` sidecars, and both hosts skip the manifest reload entirely when `manifestPath` is missing. This is not an ACE-specific bug — it affects every manifest-governed feature including the `audit` precedent earlier rounds appealed to. The activation PR should adopt the existing audit pattern (which has the same gap) and treat manifest-source-missing as "ACE off for this resumed session." A repo-wide cleanup of resume provenance backfill would be a separate, broader issue.
- **`/clear` and `/new` do not reset ACE state.** Within one TUI process, the in-memory `PlaybookStore` survives `/clear` and `/new` because both flow through `resetSessionState()` without touching the runtime-level store. Issue #2088's AC accepts this ("playbooks lost on process exit") and so does the activation PR's UX: document the limitation, point users at process restart, plan a future enhancement once telemetry shows demand.
- **Picker-loaded sessions inherit the running process's playbook store.** Same root cause as `/clear` and `/new` and the same resolution: documented limitation in the activation PR; partitioning is the future-work fix.

### Design that lands #2088 today (sketch — for the activation PR, not this branch)

```
1. Add ManifestAceConfig to manifest.ts (enabled, max_injected_tokens, min_score, lambda).
2. Reject playbook_path with pointer to future sqlite-store issue.
3. In tui-command.ts (TUI path only):
     if manifest.ace?.enabled === true:
         if "spawn" in active stacks:
             stderr: "ace: refusing to activate while spawn stack is active.
                       Set manifest.stacks to a list that excludes 'spawn'."
             continue without ACE
         else if resumed without manifestPath provenance (mirrors audit):
             stderr: "ace: skipping activation on resumed session without manifest provenance."
             continue without ACE
         else:
             build AceConfig (in-memory stores) and pass to createKoiRuntime.
             stderr: "ace: enabled (in-memory; lost on process exit; survives /clear and /new)"
4. In commands/start.ts: REJECT manifest.ace.enabled === true (matches backgroundSubprocesses precedent).
5. Tests cover: schema parse, spawn-gate refusal, resume-without-provenance refusal, koi-start rejection,
   middleware-chain snapshot when activated, in-process two-turn behavior test.
6. Docs: docs/L2/middleware-ace.md adds an "Enabling in TUI" section with the manifest example
   (manifest.stacks excluding spawn) and the documented limitations.
```

This is roughly the same shape as the earliest design draft (round 0/1), with two differences: (a) gate via `manifest.stacks` instead of a non-existent `--no-spawn` flag, (b) explicit acknowledgement that resume-without-provenance defaults to OFF (mirrors audit). No env gate, no `clear()` API, no sqlite, no partitioning required for the dogfood loop the issue actually asks for.

## Recommended next steps

### For the maintainer of issue #2088

1. **Treat #2088 as implementable** following the design sketch above. No prerequisites need to land first.
2. **Open follow-up issues** (do not block #2088 on them):
   - **Repo-wide resume provenance backfill** — `readSessionMeta()` returning `{}` for missing/malformed sidecars affects every manifest-governed feature, not just ACE. Worth a separate cleanup pass.
   - **`koi tui --no-spawn` UX flag** — convenience for ACE dogfooding (today users must edit `manifest.stacks`).
   - **`@koi/playbook-store-sqlite`** — cross-process persistence for ACE.
   - **Per-session / per-root-agent partitioning** in the ACE store APIs — would let ACE activate alongside spawn safely.
   - **`clear()` on `PlaybookStore` / `TrajectoryStore`** — would let `/clear` and `/new` reset ACE state.
3. **Implement #2088** in a fresh branch following the sketch. The PR can use this analysis as a reference (link to the spec file in `docs/superpowers/specs/`), so reviewers see why the sketch chose the gates it chose.

### For this branch (`feat/tui-ace-toml`)

The 10-round analysis trail is the artifact this branch produces. Two coherent paths:

- **Path A: Merge this analysis as a docs-only PR.** Title: `docs(spec): #2088 implementation analysis (10 review rounds)`. Body avoids GitHub close-keywords (use `refs issue 2088`). The analysis lands on `main` as a reference for the eventual implementation PR; this branch is then deleted. The implementation happens in a fresh branch that links to the merged spec.

- **Path B: Discard the branch; reproduce the design sketch in the implementation PR description.** The branch is deleted; the analysis vanishes. Acceptable if the maintainer judges the sketch self-evidently sufficient.

Path A is preferable because future ACE-adjacent work (the follow-up issues listed above) benefits from having the dismissed-blocker history in-tree.

The branch must not be merged *as a fix for #2088* — it contains no implementation code. Path A merges it as a *design analysis document*, which is a different and acceptable use of the repo.

## What this branch contains today

This branch (`feat/tui-ace-toml`) currently contains only this decision document, committed at `docs/superpowers/specs/2026-04-30-tui-ace-toml-design.md`. No source files have been modified.

History: the branch went through six prior spec revisions, each tracked as a separate commit, before reaching this conclusion. Maintainers can read the commit history (`git log --oneline -- docs/superpowers/specs/2026-04-30-tui-ace-toml-design.md`) to see how the design narrowed across review rounds.

## References

- Issue #2088 (this work): https://github.com/windoliver/koi/issues/2088
- Issue #1715 / PR #2086 (`@koi/middleware-ace` stat-pipeline surface): merged 2026-04-30
- v1 archive (where ACE first lived): `archive/v1/packages/mm/middleware-ace/`
- v1 stores-sqlite (co-located in v1, not a separate package — informs the prerequisite-1 design): `archive/v1/packages/mm/middleware-ace/src/stores-sqlite.ts`
- Existing manifest-rejection precedent: `packages/meta/cli/src/commands/start.ts:467` (`backgroundSubprocesses` rejection)
- Existing env-gate precedent: `manifest.audit` requires `KOI_AUDIT_*` env vars
- Resume-path manifest skip (the gap that defeats universal rejection): `packages/meta/cli/src/tui-command.ts:1083-1087`, `packages/meta/cli/src/commands/start.ts:390-395`
- Current ACE wiring entry-point (will be used by the activation PR): `packages/meta/runtime/src/create-runtime.ts:272-280`
- Current `RuntimeConfig.ace` field (used by activation PR): `packages/meta/runtime/src/types.ts:506`
- v2 in-memory store API (no `clear()`): `packages/lib/middleware-ace/src/in-memory-store.ts`
- L2 doc: `docs/L2/middleware-ace.md`
