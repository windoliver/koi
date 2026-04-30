# Pre-#2088: ACE manifest schema + host rejection (plumbing-only)

**Issue:** [#2088](https://github.com/windoliver/koi/issues/2088) — **partial fix; AC cannot be met under this scope**
**Depends on:** [#1715](https://github.com/windoliver/koi/issues/1715) (PR [#2086](https://github.com/windoliver/koi/pull/2086) merged 2026-04-30 — ships `@koi/ace-types` + `@koi/middleware-ace` stat-pipeline surface)
**Date:** 2026-04-30

## TL;DR

This PR is **plumbing only**: it adds the `ace:` block to `koi.yaml`, parses + validates it, rejects it in `koi start`, and threads it through `KoiRuntimeConfig` — but **does NOT install the middleware**. The actual feature activation is deferred to a follow-up PR after the prerequisite work lands (sqlite store, per-session partitioning, store-level reset API).

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
| `koi.yaml` `[ace] enabled = true` enables ACE for next TUI session | **Not met** | Schema parsed and threaded, but middleware not installed; `RuntimeConfig.ace` always undefined |
| Default behavior unchanged when `[ace]` is absent or `enabled = false` | **Met** | Trivially — middleware never installs |
| Defaults to in-memory store with startup log line | **Not met** | No middleware = no store = no log line |
| `playbook_path` lazily resolves SQLite or warns + falls back | **Not met** | Schema rejects `playbook_path` outright (issue AC: "no silent ignore") |
| Schema validation: invalid `[ace]` keys produce a clear error at TUI startup | **Met** | Parser rejects unknowns + range/type errors |
| Smoke test: `[Active Playbooks]` appears on second TUI session | **Not met** | No middleware install path |

**Recommendation to maintainer (in PR body):** retarget #2088 to track the activation PR after sqlite/partitioning land; treat this PR as `pre-#2088` plumbing. Alternatively close this PR and reopen with the prerequisites in scope.

**Required PR mechanics to avoid false closure of #2088:**

- PR title MUST start with `pre-#2088:` (not `fix #2088:` / `closes #2088`).
- PR body MUST contain the line: `Refs #2088 (does not close)` — this prevents GitHub from auto-closing the issue on merge.
- PR body MUST link to this spec and reproduce the AC gap table verbatim, so reviewers see the deferred ACs at a glance.
- A follow-up issue tracking the activation PR + prerequisites (see Prerequisites section below) MUST be opened *before* this PR merges, and linked in the PR body.

## Scope (plumbing only)

| File | LOC | Change |
|---|---|---|
| `packages/meta/cli/src/manifest.ts` | ~60 | New `ManifestAceConfig` type + parser block, mounted on `ManifestConfig.ace`. Validates `enabled` (bool), `max_injected_tokens` (>0), `min_score` (0..1), `lambda` (>0). Rejects unknown keys (incl. `playbook_path`) at load time. |
| `packages/meta/cli/src/manifest.test.ts` | ~80 | Absent block; `enabled: false`; full-block; partial-block; unknown-key reject (incl. `playbook_path`); type/range error |
| `packages/meta/cli/src/commands/start.ts` | ~10 | Reject `manifest.ace.enabled === true` (matches `backgroundSubprocesses` rejection at `start.ts:467`). `ace:` is a TUI-targeted block; rejecting in `koi start` prevents shared manifests from drifting silently across hosts. |
| `packages/meta/cli/src/commands/start.test.ts` | ~30 | `koi start` exits non-zero with clear message when manifest sets `ace.enabled: true`; ignores `enabled: false` |
| `packages/meta/cli/src/runtime-factory.ts` | ~30 | Add `manifestAce?: ManifestAceConfig` to `KoiRuntimeConfig`. **Does NOT build an `AceConfig`.** Always passes `ace: undefined` to `createRuntime`. A code comment + `TODO(#2088-followup)` marker documents that activation lands in a follow-up PR once the prerequisite work (sqlite store + session partitioning + `clear()` API) is available. |
| `packages/meta/cli/src/runtime-factory.test.ts` | ~80 | (1) `createKoiRuntime` accepts `manifestAce` without throwing. (2) Middleware chain snapshot has NO `ace` middleware regardless of `manifestAce` value (proves the deferred-activation contract). (3) **Stderr-warning matrix** (blocking — guards against silent regression to no-op): `manifestAce.enabled === true` → emits the documented stderr line; `manifestAce.enabled === false` → no stderr; `manifestAce === undefined` → no stderr. Captured via stderr spy. |
| `packages/meta/cli/src/tui-command.ts` | ~10 | Forward `manifest.ace` into `createKoiRuntime({ manifestAce })` so the field reaches the runtime layer. The TUI does not need to know that activation is deferred — the runtime factory swallows the field. |
| `packages/meta/cli/src/tui-command.test.ts` | ~20 | Manifest `[ace]` block reaches `createKoiRuntime` as `manifestAce` payload (verified by spy / mock) |
| `docs/L2/middleware-ace.md` | ~50 | New "Manifest schema (forward-compatible, not yet active)" section explaining the deferred-activation posture and listing the prerequisite work |

Total: ~370 LOC.

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
  → manifest.ts parser (validates, rejects unknowns/typos/out-of-range/playbook_path)
    → ManifestConfig.ace (typed)
      → host fork:
          - koi start: REJECT (start.ts fails fast on enabled: true)
          - koi tui:  forward manifest.ace into createKoiRuntime({ manifestAce })
              → runtime-factory.ts:
                  store on KoiRuntimeConfig.manifestAce
                  emit a one-time stderr note if enabled=true:
                    "ace: manifest.ace.enabled=true is parsed but not yet
                     wired in this build; tracked as #2088 follow-up."
                  ALWAYS call createRuntime({ ace: undefined })
                  → middleware chain unchanged
```

The startup note when `enabled: true` is parsed under TUI is critical: a user who configured the block deserves to know it didn't activate. Without the note, this PR would silently break their expectations.

## Defaults & error handling

- Block absent or `enabled: false` → `manifest.ace` is `undefined` (or stores `enabled: false`); no startup note.
- Block present + `enabled: true` under `koi tui` → parsed, stored, stderr note printed, middleware NOT installed.
- Block present + `enabled: true` under `koi start` → REJECTED at startup (matches `backgroundSubprocesses` precedent).
- **Unknown keys** under `ace:` → reject at manifest load:
  `KOI_MANIFEST: unknown key 'X' under ace; expected one of [enabled, max_injected_tokens, min_score, lambda]`
- **`playbook_path`** specifically → reject with a pointer to the future-work issue:
  `KOI_MANIFEST: 'playbook_path' under ace is not yet supported; @koi/playbook-store-sqlite has not landed (tracked as #2088 follow-up)`
- **Wrong types** (e.g. `enabled: "yes"`) → reject with type error.
- **Out-of-range numerics** → reject with range error.
- All errors surface at TUI startup (manifest load), not first model call.

## Why this is the right cut (round-by-round summary)

| Round | Reviewer flag | Resolution in this revision |
|---|---|---|
| 1 | Plumbing path: `createKoiRuntime` doesn't take manifest objects | Plumbing path now spans manifest → tui-command → KoiRuntimeConfig — preserved |
| 1 | Host scope: `koi start` undefined | `koi start` rejects (matches `backgroundSubprocesses`) — preserved |
| 1 | Cross-session leak via shared store | Removed cross-session activation entirely (no middleware install) |
| 2 | Reset hook can't be safely inserted around `cycleSession()` | Removed reset hooks (no middleware = no reset needed) |
| 2 | In-memory store has no `clear()` API | Listed as a prerequisite for the follow-up PR |
| 2 | Spawn/child contamination | Listed as a prerequisite (needs partitioning) |
| 3 | Repo-only manifest enabling prompt-shaping is a trust regression | Removed activation entirely (matches the principle: don't activate from repo content alone) |
| 3 | Documented "accept the risk" isn't enough without recovery path | No activation = no risk to recover from |
| 4 | Spec defers the only AC for #2088 | Made explicit in TL;DR + AC gap table; recommend retargeting the issue |
| 4 | Picker session-switch contamination missed | Eliminated by no-activation scope |
| 4 | `--no-spawn` flag doesn't exist | No operator-gate guidance in this PR; deferred with the rest |

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
