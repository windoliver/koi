# TUI — opt-in ACE wiring via koi.yaml

**Issue:** [#2088](https://github.com/windoliver/koi/issues/2088)
**Depends on:** [#1715](https://github.com/windoliver/koi/issues/1715) (PR [#2086](https://github.com/windoliver/koi/pull/2086) merged 2026-04-30 — ships `@koi/ace-types` + `@koi/middleware-ace` stat-pipeline surface)
**Date:** 2026-04-30

## Summary

Wire the existing `@koi/middleware-ace` into the TUI behind an opt-in `ace:` block in the `koi.yaml` manifest. Today `RuntimeConfig.ace` and `createAceMiddleware` exist but no caller opts in, leaving the middleware dormant.

## Naming note (resolved)

Issue #2088 says "koi.toml". The repo's manifest is **`koi.yaml`** — confirmed in v1 archive (`archive/v1/packages/meta/cli/src/resolve-nexus.ts`: "manifest.nexus.url from koi.yaml") and v2 manifest schema (`packages/meta/cli/src/manifest.ts` already houses `governance:`, `audit:`, `delegation:`, `supervision:` peer blocks). Treat the issue's "koi.toml" as a naming slip; ship the field in the existing YAML manifest.

## Why

- PR #2086 ships the middleware + the runtime config field, but no caller wires it. Feature unreachable from TUI.
- Default-on is premature: per-call token cost of `[Active Playbooks]`, persistence story unsettled, multi-tenant partitioning undefined.
- Opt-in via manifest is the cheapest viable path to dogfood the loop and gather convergence + cost telemetry before deciding default-on.

## Scope

| File | LOC | Change |
|---|---|---|
| `packages/meta/cli/src/manifest.ts` | ~60 | New `ManifestAceConfig` type + parser block, mounted on `ManifestConfig.ace` |
| `packages/meta/cli/src/manifest.test.ts` | ~80 | Parse valid/invalid blocks, default off, reject unknown keys, range validation |
| `packages/meta/cli/src/commands/start.ts` | ~10 | **Reject** `manifest.ace` if present (same posture as existing `backgroundSubprocesses` rejection at `start.ts:467`) — `ace:` is TUI-only |
| `packages/meta/cli/src/commands/start.test.ts` | ~30 | Verify `koi start` exits non-zero with clear message when manifest sets `ace.enabled: true` |
| `packages/meta/cli/src/runtime-factory.ts` | ~40 | Add `manifestAce?: ManifestAceConfig` to `KoiRuntimeConfig`; when `enabled === true` build `AceConfig` (in-memory stores + default consolidator) → pass via `RuntimeConfig.ace` to `createRuntime` |
| `packages/meta/cli/src/runtime-factory.test.ts` | ~80 | Middleware chain snapshot (off vs on); in-process two-turn behavior test |
| `packages/meta/cli/src/tui-command.ts` | ~10 | Forward `manifest.ace` into `createKoiRuntime({ manifestAce })` (the only host that should — start.ts already rejected the field) |
| `packages/meta/cli/src/tui-command.test.ts` | ~40 | TUI startup with `[ace] enabled = true` plumbs `manifestAce` into `createKoiRuntime`; `/clear` and `/new` reset playbook store (see Reset semantics below) |
| `docs/L2/middleware-ace.md` | ~30 | New "Enabling in TUI" section, including reset semantics + host scope |

Total: ~380 LOC.

## Surface

```yaml
ace:
  enabled: true
  # optional overrides — all map 1:1 to v2 AceConfig fields:
  max_injected_tokens: 800   # → maxInjectedTokens
  min_score: 0.05            # → minScore
  lambda: 0.05               # → lambda
```

> v2 `AceConfig` (in `packages/lib/middleware-ace/src/ace-middleware.ts:39`) currently exposes only these three knobs plus the stores. v1 had `playbookTags` / `minCurationScore` / `recencyDecayLambda`; v2 simplified the names and dropped tag filtering. We expose only what v2 supports — adding `tags:` later is a one-line schema addition once the middleware re-introduces it.

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
  → manifest.ts parser (validates, rejects unknowns, sets defaults)
    → ManifestConfig.ace (typed)
      → host fork:
          - koi start: REJECT (start.ts fails fast, same as backgroundSubprocesses)
          - koi tui:  forward manifest.ace into createKoiRuntime({ manifestAce })
              → runtime-factory.ts builds AceConfig (in-memory stores)
                → createRuntime({ ace })
                  → create-runtime.ts (already done in PR #2086):
                    installs createAceMiddleware(config.ace) at end of chain
```

The plumbing crosses three boundaries because `createKoiRuntime` does not receive the manifest object directly — `tui-command.ts` parses the manifest and forwards individual fields into `KoiRuntimeConfig` (see existing `manifestMiddleware`, `manifestNdjsonSourcePath`, etc.). `manifestAce` follows the same pattern.

`runtime-factory.ts` builds the `AceConfig` like:

```typescript
const aceConfig: AceConfig | undefined =
  manifest.ace?.enabled === true
    ? {
        trajectoryStore: createInMemoryTrajectoryStore(),
        playbookStore: createInMemoryPlaybookStore(),
        consolidate: createDefaultConsolidator({}),
        ...(manifest.ace.maxInjectedTokens !== undefined && {
          maxInjectedTokens: manifest.ace.maxInjectedTokens,
        }),
        ...(manifest.ace.minScore !== undefined && {
          minScore: manifest.ace.minScore,
        }),
        ...(manifest.ace.lambda !== undefined && {
          lambda: manifest.ace.lambda,
        }),
      }
    : undefined;
```

Single startup log line on enable:
```
ace: enabled (in-memory store; playbooks reset on /clear, /new, and process exit)
```

## Host scope

`ace:` is **TUI-only** in this PR (matches issue #2088 title and the `backgroundSubprocesses` precedent at `packages/meta/cli/src/commands/start.ts:467`):

- `koi tui` honors `ace:`.
- `koi start` REJECTS any manifest where `ace.enabled === true` with a clear message:
  `manifest.ace: not supported on koi start (TUI-only). Remove the [ace] block or move it to a TUI-specific manifest.`
- `koi start` IGNORES `ace.enabled === false` (no-op block is harmless).

This prevents shared manifests from silently enabling ACE in headless `koi start`, which has a different safety posture (no `/clear`, `/new` reset hooks; longer-lived processes).

## Reset semantics

The in-memory playbook store lives for the lifetime of the TUI process, so without explicit reset hooks, `/clear` and `/new` would carry forward learned guidance from a prior conversation — surprising the user and potentially leaking stale context.

This PR wires reset behavior:

- **`/clear`** (truncate transcript, keep session) → clear in-memory `PlaybookStore` and `TrajectoryStore`.
- **`/new`** (start a new session) → clear both stores.
- **Resume** (`--resume`) → no clear (resuming the same logical conversation).
- **Process exit** → store is GC'd, all playbooks lost (documented; sqlite store will fix this in the follow-up issue).

Implementation: `runtime-factory.ts` retains a reference to the constructed stores and exposes a `resetAceStores()` callback on the runtime handle. `tui-command.ts` invokes this callback from the existing `/clear` and `/new` reset paths (next to `rewindBoundaryActive` flagging at `tui-command.ts:2944`).

If a future PR adds session/workspace partitioning to the ACE store, this hook can become a no-op or a per-session selector — the boundary is preserved.

## Defaults & error handling

- Block absent or `enabled: false` → `manifest.ace` is `undefined` → `RuntimeConfig.ace` undefined → middleware NOT installed. Middleware chain identical to today (snapshot-verified).
- Block present + `enabled: true` with no overrides → `@koi/middleware-ace` defaults apply (already shipped in PR #2086).
- **Unknown keys** under `ace:` → reject at manifest load:
  `KOI_MANIFEST: unknown key 'X' under ace; expected one of [enabled, max_injected_tokens, min_score, lambda]`
- **Wrong types** (e.g. `enabled: "yes"`) → reject with type error.
- **Out-of-range numerics**:
  - `max_injected_tokens > 0`
  - `0 ≤ min_score ≤ 1`
  - `lambda > 0`
- All errors surface at TUI startup (manifest load), not first model call.

## Testing strategy

### Manifest parsing (~6 tests)
1. No `ace:` block → `manifest.ace === undefined`
2. `ace: { enabled: false }` → `manifest.ace.enabled === false`, all overrides undefined
3. Full block with all overrides → all fields populated
4. Partial block (only `enabled` + `min_score`) → only those fields populated
5. Unknown key → throws `KOI_MANIFEST: unknown key`
6. Type error / range error → throws specific error

### Host rejection (`koi start`) (~2 tests)
1. `manifest.ace.enabled === true` → `koi start` exits non-zero with the documented message
2. `manifest.ace.enabled === false` → `koi start` proceeds normally (no-op block)

### TUI plumbing (`tui-command.ts`) (~2 tests)
1. Manifest has `ace: { enabled: true, ... }` → `createKoiRuntime` is called with matching `manifestAce` payload
2. Manifest has no `ace:` → `createKoiRuntime` receives `manifestAce: undefined`

### Reset hooks (~2 tests)
1. After `/clear`, the in-memory `PlaybookStore` and `TrajectoryStore` are empty
2. After `/new`, both stores are empty; resume path does NOT clear

### Runtime-factory plumbing (~2 tests)
1. `manifestAce` undefined → middleware chain snapshot has NO `ace` middleware
2. `manifestAce.enabled === true` → middleware chain snapshot has `ace` at the expected position

### In-process behavior (~1 test)
- Build runtime with `enabled: true` + in-memory stores
- Simulate session 1: record tool failure via `wrapToolCall` → trigger `onSessionEnd` → consolidate
- Simulate session 2 (same process, same store): next `wrapModelCall` injection includes `[Active Playbooks]` system message referencing the failed tool

## Out of scope (explicit non-goals)

- `playbook_path` / persistent backend — `@koi/playbook-store-sqlite` does not exist; tracked as separate follow-up issue. Until it lands, only in-memory store is supported. Schema rejects `playbook_path` rather than silently ignoring it (issue AC: "invalid keys produce a clear error").
- Cross-session TUI smoke test — deferred to the sqlite-store PR where it actually verifies persistence.
- LLM reflector + curator — separate scope of #1715.
- AGP promotion gate — separate scope of #1715.
- `--ace` CLI flag — manifest is single source of truth (issue non-goal).

## References

- v1 archive: `archive/v1/packages/mm/middleware-ace/src/config.ts` (full v1 `AceConfig` shape — superset of what we expose), `stores-sqlite.ts` (persistent store was co-located in v1, not a separate package)
- v1 manifest convention: `archive/v1/packages/meta/cli/src/resolve-nexus.ts` (uses `koi.yaml`)
- claude-code source: strict settings schema rejects unknown keys (`src/utils/settings/types.ts: SettingsSchema`) — same fail-fast posture
- Current ACE wiring entry-point: `packages/meta/runtime/src/create-runtime.ts:272-280`
- Current `RuntimeConfig.ace` field: `packages/meta/runtime/src/types.ts:506`
- Doc: `docs/L2/middleware-ace.md`
