# Issue #2088 — Block decision and prerequisite tracking

**Issue:** [#2088](https://github.com/windoliver/koi/issues/2088) — **recommended status: BLOCKED on prerequisites; do not implement as written**
**Depends on:** [#1715](https://github.com/windoliver/koi/issues/1715) (PR [#2086](https://github.com/windoliver/koi/pull/2086) merged 2026-04-30 — ships `@koi/ace-types` + `@koi/middleware-ace` stat-pipeline surface)
**Date:** 2026-04-30
**Status:** Decision document. No code changes recommended in this branch.

## TL;DR

Seven rounds of adversarial review on this issue progressively narrowed the safe scope until what was left had no implementable feature payoff. The honest conclusion is that **issue #2088 cannot ship safely without prerequisite work** that is out of scope for any single "wire ACE into the TUI" PR. This document records the analysis, names the prerequisites, and recommends holding #2088 until they land.

The branch this spec is committed on (`feat/tui-ace-toml`) should be **closed without merging**, or repurposed to host one of the prerequisite PRs identified below.

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

## Why issue #2088 is blocked

The cumulative review surfaced two distinct categories of issue. Only the first set are **hard blockers** — without them, opt-in ACE in the TUI silently contaminates contexts the user reasonably believes are isolated. The second set are **enhancements** that this review history previously misclassified as blockers; the corrected analysis lives in the next subsection.

### Hard blockers (must land before #2088 activation)

1. **Per-session / per-root-agent partitioning** in the ACE store APIs. The current `PlaybookStore` is process-scoped, and `createAceMiddleware()` loads/saves playbooks without a session or agent key. With the spawn preset stack active (the TUI default), child agents spawned via `task_delegate` share a namespace with the parent, and picker-switched sessions in the same process see the prior session's learned playbooks. There is no in-product recovery path. Either the store API needs a session/agent-keyed surface, or activation must hard-disable when contamination paths are reachable.
2. **CLI escape hatch for spawn-active manifests.** Even after partitioning lands, an operator who wants ACE without the spawn preset stack needs a way to launch the TUI without it. Today there is no `--no-spawn` flag, and stack selection is only manifest-driven. Without this, the activation PR's only opt-in path is "edit your manifest's `stacks` field," which is a poor UX for a dogfood feature.
3. **Operator activation gate** (env var or user-local config) so repo-controlled `koi.yaml` cannot enable a prompt-shaping middleware on its own. Matches the existing `manifest.audit` env-gate precedent (which requires `KOI_AUDIT_*` env vars before declared sink paths take effect). Without this gate, cloning a malicious or stale-config repo can silently change model prompt behavior for the operator.

### Enhancements (nice-to-have, NOT activation blockers)

These were flagged as blockers in earlier review rounds. Re-examining the actual code shows they are not.

- **`@koi/playbook-store-sqlite`** — would add cross-process persistence (playbooks survive a TUI restart). The current in-memory store already keeps playbooks across `/clear`, `/new`, and picker switches *within a single process* because the `PlaybookStore` is constructed once in the runtime and lives until process exit. That is the same boundary issue #2088's AC explicitly accepts ("playbooks will not survive process exit"). Sqlite is a useful follow-up, not a prerequisite for the activation PR. The dogfood flow (one TUI session learns; the next session in the same TUI process injects) works on the in-memory store today.
- **`clear()` capability on the store APIs** — only relevant if `/clear` and `/new` should reset ACE state, which is a UX choice rather than a safety blocker. Issue #2088 doesn't require it. Document the absence as an intentional limitation in the activation PR; revisit if telemetry shows users expect resets.
- **Resume-path ACE re-validation** — round 7 framed this as a fundamental architecture gap. The corrected reading: the codebase already re-runs `loadManifestConfig(resumeMeta.manifestPath, ...)` on `--resume` for audit enforcement (see existing audit-resume logic in `tui-command.ts` around line 1420 and `commands/start.ts` around line 690). The activation PR just needs to add an analogous ACE check at the same point. Not a separate prerequisite — it's the activation PR's own work.

## Recommended next steps

### For the maintainer of issue #2088

1. **Mark #2088 as blocked** on the three hard-blocker prerequisites listed above.
2. **Open prerequisite issues** for the three hard blockers:
   - One issue for **per-session/per-root-agent partitioning** in the ACE store APIs (extends `PlaybookStore` / `TrajectoryStore` with a session or agent key; updates `createAceMiddleware` to use it).
   - One issue for the **CLI escape hatch**: add `koi tui --no-spawn` (and matching arg parsing in `args/tui.ts`) so the operator can opt out of the spawn preset stack at launch.
   - One issue for the **operator activation gate**: add `KOI_ACE_DOGFOOD=1` (or equivalent user-local config) check in the activation PR's manifest-honoring path.
3. **Defer the actual #2088 implementation PR** until at least the partitioning issue lands. The escape-hatch and activation-gate issues can be co-implemented with the activation PR if desired.

The follow-up "enhancements" section above (sqlite, `clear()`, resume re-check) should be tracked but not block #2088. They are natural follow-ups *after* activation, when telemetry can drive the priority.

### For this branch (`feat/tui-ace-toml`)

The blocker analysis must persist somewhere durable — the in-repo `docs/superpowers/specs/` directory or the GitHub issue tracker. Pick one of these consistent paths:

- **Path A: Merge this decision document.** Open a docs-only PR titled `docs(spec): block #2088 on prerequisites — analysis from 7 review rounds` containing only `docs/superpowers/specs/2026-04-30-tui-ace-toml-design.md`. Body must avoid GitHub close-keywords (no `closes #2088` etc.) — use `refs issue 2088` instead. The spec lands on `main` as the durable record; the branch is then deleted. Subsequent prerequisite PRs link back to this spec.

- **Path B: Move the analysis to GitHub, close the branch unmerged.** Before deleting the branch:
  1. Open the prerequisite issues listed above and link each to #2088 as `Blocks: #2088`.
  2. Post the "Why issue #2088 is blocked" section as a comment on #2088 (preserve the prerequisite numbering and references).
  3. Edit #2088's body to reference the new prerequisite issues at the top: `Blocked by: #<partitioning>, #<no-spawn-flag>, #<activation-gate>`.
  4. Then delete the branch.

  After this, the spec file ceases to exist anywhere — that's acceptable because the analysis lives on the issue tracker.

Either path produces a durable record. Do **not** delete the branch without first executing Path A or Path B in full — that would lose the seven rounds of analysis.

The branch must not be merged in its current form *as a fix for #2088* (one decision doc, no code, no test coverage). Path A above merges it as a *block-record document*, which is a different and acceptable use of the repo.

### For the issue text itself

Issue #2088's acceptance criteria assume an in-memory store is sufficient because they only require "playbooks lost on process exit." That AC was written before the contamination boundaries (spawn, picker, resume, `/clear`, `/new`) were enumerated in this review. Recommend updating the issue body to either:

- Acknowledge the prerequisites and link to the new prerequisite issues, or
- Tighten the AC to require persistence + per-session partitioning before activation.

Either way, do not close #2088 from a merge of any of the prerequisite PRs; #2088 is the *integration* issue that lights up only after prereqs are in place.

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
