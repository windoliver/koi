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

For ACE to land in the TUI in a way that meets the issue's acceptance criteria *and* satisfies the safety boundaries the codebase already enforces for similar features, all of these must exist first. None do today:

1. **`@koi/playbook-store-sqlite`** — a persistent, per-process backend so cross-session learning has somewhere to live across `/clear`, `/new`, picker switches, and process restart. The current in-memory store is per-process only, with no `clear()` operation, and the v2 ACE store interface (`PlaybookStore`, `TrajectoryStore`) does not expose a deletion API.
2. **Per-session and per-root-agent partitioning** in the store APIs. Without partitioning, child agents spawned via `task_delegate` share a namespace with the parent, and picker-switched sessions inherit prior playbooks. Both are silent prompt contamination paths with no in-product recovery.
3. **`clear()` capability** on `PlaybookStore` and `TrajectoryStore` (or a session-scoped variant) so `/clear` and `/new` can reset store contents at the documented user expectation.
4. **Resume-path manifest re-validation** for ACE. Both `koi tui` and `koi start` skip cwd manifest auto-discovery on `--resume` (without `--manifest`). Any host-scope rejection of `manifest.ace.enabled: true` is therefore not universal: a user who edits `koi.yaml` between sessions and resumes can carry forward a stale-validated manifest. Activation must explicitly re-check ACE state at resume (or refuse to resume sessions where the cwd manifest has changed in ways that affect ACE).
5. **Operator activation gate** (env var or user-local config) so repo-controlled `koi.yaml` cannot enable a prompt-shaping middleware on its own. Matches the existing `manifest.audit` env-gate precedent.
6. **CLI escape hatch for spawn-active manifests** — either an actual `--no-spawn` flag (does not exist today) or documented manifest-stack guidance for users who want ACE without the spawn preset stack.

These are not yak-shaving. Each one is the failure mode of an actual flagged regression in this review history. Without them, ACE in the TUI either (a) silently contaminates contexts the user thinks are isolated, or (b) requires so many opt-in gates that the activation path is effectively unreachable.

## Recommended next steps

### For the maintainer of issue #2088

1. **Mark #2088 as blocked** on a prerequisite epic or umbrella issue.
2. **Open prerequisite issues** for the six items above (or fold them into existing #1715 follow-ups). Suggested split:
   - One issue for the sqlite-store package (covers prerequisite 1).
   - One issue for partitioning + `clear()` in the store API (covers 2 and 3) — likely co-implemented with the sqlite store.
   - One issue for resume-path ACE re-validation (covers 4) — depends on the prior two.
   - One issue for the operator activation gate + escape hatch (covers 5 and 6) — independent of the others.
3. **Defer the actual #2088 implementation PR** until at least the first three issues are merged. At that point a re-spec of #2088 will look very different from the current text — likely bigger but actually shippable.

### For this branch (`feat/tui-ace-toml`)

Two acceptable paths:

- **Close without merging.** This spec stays in `docs/superpowers/specs/` as the record of why; the branch is deleted. Maintainer reopens against the prerequisite issues above when they land.
- **Repurpose for a single prerequisite.** Pick one of the prerequisite issues that's small and self-contained (for example, the operator activation gate, which is repo-config and CLI-level, not L2-coupled) and rewrite this branch to deliver just that. Update the branch name and commits accordingly.

The branch should not be merged in its current form (one decision doc, no code, no test coverage).

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
