# Pre-#2088: ACE manifest schema + host rejection (plumbing-only)

**Issue:** [#2088](https://github.com/windoliver/koi/issues/2088) — **partial fix; AC cannot be met under this scope**
**Depends on:** [#1715](https://github.com/windoliver/koi/issues/1715) (PR [#2086](https://github.com/windoliver/koi/pull/2086) merged 2026-04-30 — ships `@koi/ace-types` + `@koi/middleware-ace` stat-pipeline surface)
**Date:** 2026-04-30

## TL;DR

This PR is **schema + host-rejection only**: it registers the `ace:` block in `koi.yaml`'s parser so the type is known to the manifest loader, **rejects `enabled: true` on every host** (TUI and start) until the activation PR lands, and accepts `enabled: false` as a valid declarative no-op. It does **not** thread the field into `KoiRuntimeConfig`, install middleware, or change the runtime in any way. The actual feature activation is deferred to a follow-up PR after the prerequisite work lands (sqlite store, per-session partitioning, store-level reset API).

This is the strictest fail-closed posture: a repo with `ace.enabled: true` will not start `koi tui` or `koi start` at all, matching the existing precedent for `backgroundSubprocesses` (which rejects in `koi start`). There is no path where the manifest looks accepted but the runtime contract is unhonored.

Why: four rounds of adversarial review surfaced safety boundaries that the v2 ACE store API + TUI session lifecycle cannot satisfy today:

1. Repo-controlled `koi.yaml` should not enable prompt-shaping middleware on its own (matches `manifest.audit` env-gate precedent — needs operator gate).
2. Shared in-memory store contaminates across `/clear`, `/new`, **session picker switches** (`resetSessionState({ truncate: false })`), and child agents spawned via `task_delegate`.
3. The in-memory store API exposes no `clear()` / partitioning surface.
4. The proposed operator escape hatch (`koi tui --no-spawn`) doesn't exist as a CLI flag.

Each individual safety gate we considered (env var, spawn-disable, picker-switch-disable) narrows the activation path further until it reaches near-zero. The honest conclusion: **wiring should land separately from activation**.

## Naming note (resolved)

Issue #2088 says "koi.toml". The repo's manifest is `koi.yaml` — confirmed in v1 archive (`archive/v1/packages/meta/cli/src/resolve-nexus.ts`) and v2 manifest schema (which already houses `governance:`, `audit:`, `delegation:`, `supervision:` peer blocks). Treat the issue's "koi.toml" as a naming slip; ship the field in the existing YAML manifest.

## Issue #2088 acceptance criteria — explicit gap analysis

| AC from #2088 | Status under this PR | Reason |
|---|---|---|
| `koi.yaml` `[ace] enabled = true` enables ACE for next TUI session | **Not met (hard-fails)** | `enabled: true` now rejected at manifest load on every host. Operators get a loud error pointing at the follow-up issue. |
| Default behavior unchanged when `[ace]` is absent or `enabled = false` | **Met** | Block absent / `enabled: false` are accepted no-ops; middleware never installs |
| Defaults to in-memory store with startup log line | **Not met** | No middleware install path |
| `playbook_path` lazily resolves SQLite or warns + falls back | **Not met (hard-fails)** | Schema rejects `playbook_path` with pointer to follow-up |
| Schema validation: invalid `[ace]` keys produce a clear error at TUI startup | **Met** | Parser rejects unknowns + range/type errors |
| Smoke test: `[Active Playbooks]` appears on second TUI session | **Not met** | No middleware install path |

**Recommendation to maintainer (in PR body):** treat this PR as schema-only ground-laying. Retarget #2088 to the activation PR after the prerequisites land.

**Required PR mechanics to avoid false closure of #2088:**

- PR title and body MUST NOT contain GitHub close-keywords (`close`, `closes`, `closed`, `fix`, `fixes`, `fixed`, `resolve`, `resolves`, `resolved`) followed by `#2088` — these auto-close the issue on merge.
- The safe pattern is to write `issue 2088` (no `#`) or link via the spec only. GitHub does not auto-close on plain text or spec-mediated references.
- The PR body should reproduce the AC gap table verbatim so reviewers see what is *not* delivered.
- A follow-up issue tracking the activation PR + prerequisites (see Prerequisites section below) should be opened *before* this PR merges and linked in the PR body.

This is doc-only enforcement; no CI gate. The reviewer who flagged this is correct that it depends on maintainer discipline. Adding a CI check to scan PR metadata for close-keywords-vs-#2088 is out of scope here — propose it as a separate repo-infra PR if desired.

## Scope (schema + rejection only)

| File | LOC | Change |
|---|---|---|
| `packages/meta/cli/src/manifest.ts` | ~70 | New `ManifestAceConfig` type + parser block, mounted on `ManifestConfig.ace`. Validates `enabled` (bool), `max_injected_tokens` (>0), `min_score` (0..1), `lambda` (>0). Rejects unknown keys (incl. `playbook_path`) at load time. **Rejects `enabled: true` on every host** with the message: `KOI_MANIFEST: ace.enabled=true is not yet supported in this build; tracked as #2088 follow-up. Set enabled: false or remove the [ace] block.` Allows `enabled: false` as a valid declarative no-op so users can stage their config ahead of the activation PR. |
| `packages/meta/cli/src/manifest.test.ts` | ~100 | Absent block → `manifest.ace === undefined`; `enabled: false` → parses with all overrides preserved; `enabled: true` → manifest load throws with the documented message; full-block with `enabled: false` and overrides → parses; unknown-key reject (incl. `playbook_path`); type/range error |
| `packages/meta/cli/src/commands/start.ts` | ~0 | No change required — manifest load already rejects `enabled: true` for every host, so `koi start` inherits the rejection. |
| `packages/meta/cli/src/runtime-factory.ts` | ~0 | No change required in this PR — since `enabled: true` cannot reach the runtime layer, no `KoiRuntimeConfig` field is needed yet. The activation PR will add `manifestAce` then. |
| `packages/meta/cli/src/tui-command.ts` | ~0 | No change required — `enabled: false` is a no-op; `enabled: true` cannot pass manifest load. |
| `docs/L2/middleware-ace.md` | ~50 | New "Manifest schema (declarative-only in this build)" section: explains why `enabled: true` is currently rejected, what prerequisites must land before activation, and how to stage `enabled: false` config in the meantime. |

Total: ~220 LOC, all in `manifest.ts`, its tests, and docs. No changes to `runtime-factory.ts`, `tui-command.ts`, or `commands/start.ts`.

## Surface

```yaml
ace:
  enabled: true
  # optional overrides — all map 1:1 to v2 AceConfig fields
  # (validated and stored, but currently inert until activation PR):
  max_injected_tokens: 800   # → maxInjectedTokens
  min_score: 0.05            # → minScore
  lambda: 0.05               # → lambda
```

> v2 `AceConfig` (in `packages/lib/middleware-ace/src/ace-middleware.ts:39`) currently exposes only these three knobs plus the stores. We expose only what v2 supports.

### `ManifestAceConfig` shape

```typescript
export interface ManifestAceConfig {
  readonly enabled: boolean;
  readonly maxInjectedTokens: number | undefined;
  readonly minScore: number | undefined;
  readonly lambda: number | undefined;
}
```

`ManifestConfig.ace?: ManifestAceConfig | undefined` — `undefined` when block absent.

## Flow

```
koi.yaml [ace] block
  → manifest.ts parser
      validates: enabled (bool), max_injected_tokens (>0), min_score (0..1), lambda (>0)
      rejects: unknown keys, playbook_path, type errors, range errors
      rejects: enabled: true (on every host — TUI and start)
      accepts: enabled: false (no-op)
      accepts: block absent (no-op)
    → If accepted, sets ManifestConfig.ace (typed)
        → No downstream consumer in this PR. The field is dead weight
          until the activation PR adds the consumer.
```

There is no per-host fork because rejection happens at manifest load (a layer above host dispatch). The TUI never sees an `enabled: true` config; neither does `koi start`. This is strictly stronger than the previous round's parse-and-warn design: there is no path where the manifest looks accepted but ACE is silently inert.

## Defaults & error handling

- Block absent → `manifest.ace === undefined`. No effect.
- Block present, `enabled: false` → `manifest.ace.enabled === false`, overrides parsed and stored. No effect at runtime (no consumer yet); valid declarative no-op.
- Block present, `enabled: true` (any host) → manifest load throws:
  `KOI_MANIFEST: ace.enabled=true is not yet supported in this build; tracked as #2088 follow-up. Set enabled: false or remove the [ace] block.`
- **Unknown keys** under `ace:` → reject at manifest load:
  `KOI_MANIFEST: unknown key 'X' under ace; expected one of [enabled, max_injected_tokens, min_score, lambda]`
- **`playbook_path`** specifically → reject with a pointer to the future-work issue:
  `KOI_MANIFEST: 'playbook_path' under ace is not yet supported; @koi/playbook-store-sqlite has not landed (tracked as #2088 follow-up)`
- **Wrong types** (e.g. `enabled: "yes"`) → reject with type error.
- **Out-of-range numerics** → reject with range error.
- All errors surface at manifest load (TUI startup or `koi start` startup), not first model call.

### Schema evolution policy (no version-skew claim)

Earlier drafts called the schema "forward-compatible." It isn't, and shouldn't pretend to be: this is a per-repo config file, not a wire format. Future ACE keys (e.g. `playbook_path`, persistence backends, partitioning hints) land **atomically with their consumer** — the same PR adds the schema entry and the runtime code that honors it. Older binaries hard-failing on a new field is the intended behavior, matching how `governance:`, `audit:`, and `supervision:` work today. Operators who pin a manifest to a feature must pin to a binary that supports it.

## Why this is the right cut (round-by-round summary)

| Round | Reviewer flag | Resolution in this revision |
|---|---|---|
| 1 | Plumbing path: `createKoiRuntime` doesn't take manifest objects | N/A in current scope — no runtime threading |
| 1 | Host scope: `koi start` undefined | Manifest-load rejection covers all hosts uniformly |
| 1 | Cross-session leak via shared store | Removed activation entirely |
| 2 | Reset hook can't be safely inserted around `cycleSession()` | N/A — no middleware install |
| 2 | In-memory store has no `clear()` API | Prerequisite for activation PR |
| 2 | Spawn/child contamination | Prerequisite (needs partitioning) |
| 3 | Repo-only manifest enabling prompt-shaping is a trust regression | Removed activation entirely |
| 3 | Documented "accept the risk" isn't enough without recovery path | No activation = no risk |
| 4 | Spec defers the only AC for #2088 | Explicit in TL;DR + AC gap table |
| 4 | Picker session-switch contamination missed | Eliminated by no-activation scope |
| 4 | `--no-spawn` flag doesn't exist | N/A — no operator-gate guidance |
| 5 | False closure of #2088 depends on PR mechanics | Acknowledged as doc-only; close-keyword guidance below |
| 5 | Inert-config warning needs test | N/A — no inert config (rejected at parse) |
| 6 | "Parse but ignore" weaker than fail-closed | Now fail-closed at manifest load for `enabled: true` on every host |
| 6 | "Forward-compatible" claim conflicts with strict reject | Dropped the claim; documented atomic schema-with-consumer policy |
| 6 | Doc-only enforcement of close-keyword discipline | Acknowledged limitation; no CI gate proposed in this PR |

## Prerequisites tracked for the follow-up activation PR

The activation PR (which would actually meet #2088's smoke-test AC) requires all of:

1. `@koi/playbook-store-sqlite` — a persistent, per-process backend so cross-session learning has a place to live.
2. **Per-session/per-root-agent partitioning** in the store APIs — so picker-switches, `/new`, and `task_delegate` children don't share a namespace.
3. **`clear()` capability** on `PlaybookStore` and `TrajectoryStore` (or a session-scoped variant) — so `/clear` and `/new` reset the store contents.
4. **Operator activation gate** (env var or user-local config) — so repo `koi.yaml` cannot enable ACE on its own.
5. **CLI escape hatch** for spawn-active manifests — either an actual `--no-spawn` flag or documented manifest-stack guidance.

This PR establishes the schema and config-surface that the activation PR will plug into. The schema is forward-compatible: adding `playbook_path` (or other future knobs) is a one-line addition once the backing implementation exists.

## Out of scope (explicit non-goals)

- Middleware installation / activation — deferred to follow-up PR after prerequisites listed above.
- `playbook_path` schema acceptance — schema explicitly rejects until sqlite-store lands.
- `/clear` and `/new` reset semantics — deferred (no activation = no state to reset).
- Per-root-agent partitioning — deferred (sqlite-store concern).
- LLM reflector + curator, AGP promotion gate, `ace_reflect` tool — separate scope of #1715.
- `--ace` CLI flag — manifest is single source of truth (issue non-goal).

## References

- v1 archive: `archive/v1/packages/mm/middleware-ace/src/config.ts` (full v1 `AceConfig` shape — superset of what we expose), `stores-sqlite.ts` (persistent store was co-located in v1, not a separate package)
- v1 manifest convention: `archive/v1/packages/meta/cli/src/resolve-nexus.ts` (uses `koi.yaml`)
- claude-code source: strict settings schema rejects unknown keys (`src/utils/settings/types.ts: SettingsSchema`) — same fail-fast posture
- Existing host-rejection precedent: `packages/meta/cli/src/commands/start.ts:467` (`backgroundSubprocesses`)
- Existing env-gate precedent: `manifest.audit` requires `KOI_AUDIT_*` env vars
- Current ACE wiring entry-point (will be used by activation PR): `packages/meta/runtime/src/create-runtime.ts:272-280`
- Current `RuntimeConfig.ace` field (will be used by activation PR): `packages/meta/runtime/src/types.ts:506`
- Doc: `docs/L2/middleware-ace.md`
