# `@koi/settings` — Hierarchical Settings Cascade Design

**Date:** 2026-04-22
**Issue:** [#1958](https://github.com/windoliver/koi/issues/1958)
**Branch:** `worktree-settings-cascade`

---

## Problem

Koi has one config surface today: `koi.yaml` (the agent manifest). Operator and user preferences — permission rules, hooks, env vars, theme, MCP server lists — have nowhere to live that is separate from the agent definition. This conflates two concerns:

1. **"This is the agent"** — manifest (`koi.yaml`), checked into the project repo
2. **"This is how my machine / org runs agents"** — settings, per-user or per-operator, not checked in

## Solution

A new L0u package `@koi/settings` that loads and merges a 5-layer settings cascade at startup. Each layer is an optional JSON file; later layers override earlier ones except policy, which wins unconditionally.

---

## Architecture

### Package placement

| Property | Value |
|----------|-------|
| Package name | `@koi/settings` |
| Layer | L0u (added to `L0U_PACKAGES` in `scripts/layers.ts`) |
| Location | `packages/lib/settings/` |
| Dependencies | `@koi/core`, `@koi/validation`, `zod` |
| Dependents | `@koi/permissions` (L2), `@koi/hooks` (L0u), `@koi/cli` / `@koi/runtime` (L3) |

`@koi/settings` is L0u — a pure cascade loader with no business logic — so both L2 packages and peer L0u packages can import it freely without circular dependencies. This mirrors how `@koi/config` is already L0u.

### File structure

```
packages/lib/settings/src/
  schema.ts          # Zod schema for KoiSettings + JSON Schema export
  paths.ts           # File path resolution per layer
  merge.ts           # Array concat, scalar last-wins, object deep-merge customizer
  loader.ts          # Per-layer load + merge algorithm + policy fail-closed guard
  types.ts           # SettingsLayer, SettingsLoadResult, SettingsLoadOptions, ValidationError
  index.ts           # Public exports
  schema.test.ts
  paths.test.ts
  merge.test.ts
  loader.test.ts
```

### Consumer wiring (no cascade logic in consumers)

- **`@koi/permissions`** — `rule-loader.ts` maps `KoiSettings.permissions` → `SourcedRule[]`. Gains `"flag"` as 5th `RuleSource` tier.
- **`@koi/hooks`** — `loader.ts` maps `KoiSettings.hooks` → `HookConfig[]`.
- **`@koi/cli` / `@koi/runtime`** — call `loadSettings()` at startup, pass `SettingsLoadResult` down.

---

## Layer Cascade

### Precedence (lowest → highest)

| # | Layer | Default path | Notes |
|---|-------|-------------|-------|
| 1 | `user` | `~/.koi/settings.json` | Personal defaults |
| 2 | `project` | `<cwd>/.koi/settings.json` | Shared team defaults, checked in |
| 3 | `local` | `<cwd>/.koi/settings.local.json` | Per-user project overrides, gitignored |
| 4 | `flag` | `SettingsLoadOptions.flagPath` | CLI `--settings <path>`, ephemeral |
| 5 | `policy` | `/etc/koi/policy.json` (Linux)<br>`/Library/Application Support/koi/policy.json` (macOS) | Admin-controlled, wins unconditionally |

Later layers override earlier ones. Policy (layer 5) also runs a post-merge enforcement pass — it can only tighten, never loosen.

### `RuleSource` update in `@koi/permissions`

The existing `RuleSource` union gains `"flag"`:

```typescript
// packages/security/permissions/src/rule-types.ts
export type RuleSource = "policy" | "flag" | "project" | "local" | "user";

export const SOURCE_PRECEDENCE: readonly RuleSource[] = [
  "policy",
  "flag",
  "local",
  "project",
  "user",
] as const;
```

---

## Schema

```typescript
// types.ts
export type SettingsLayer = "user" | "project" | "local" | "flag" | "policy";

export interface ValidationError {
  readonly file: string;
  readonly path: string;
  readonly message: string;
}

export interface SettingsLoadOptions {
  readonly cwd?: string;        // project root; defaults to process.cwd()
  readonly homeDir?: string;    // user home; defaults to os.homedir()
  readonly flagPath?: string;   // --settings <path> CLI flag value
  readonly layers?: readonly SettingsLayer[];  // subset to load; defaults to all 5
  readonly env?: Record<string, string>;       // injected into env merge
}

export interface SettingsLoadResult {
  readonly settings: KoiSettings;
  readonly errors: readonly ValidationError[];
  readonly sources: Readonly<Record<SettingsLayer, KoiSettings | null>>;
}
```

```typescript
// schema.ts (Zod-backed, shape only — no runtime logic)
export interface KoiSettings {
  readonly $schema?: string;
  readonly permissions?: {
    readonly defaultMode?: "default" | "bypass" | "plan" | "auto";
    readonly allow?: readonly string[];
    readonly ask?: readonly string[];
    readonly deny?: readonly string[];
    readonly additionalDirectories?: readonly string[];
  };
  readonly env?: Readonly<Record<string, string>>;
  readonly hooks?: {
    readonly PreToolUse?: readonly HookCommand[];
    readonly PostToolUse?: readonly HookCommand[];
    readonly SessionStart?: readonly HookCommand[];
    readonly SessionEnd?: readonly HookCommand[];
    readonly Stop?: readonly HookCommand[];
    // mirrors @koi/hooks HookEventKind exactly
  };
  readonly apiBaseUrl?: string;
  readonly theme?: "dark" | "light" | "system";
  readonly enableAllProjectMcpServers?: boolean;
  readonly disabledMcpServers?: readonly string[];
}
```

`HookCommand` is defined inline in `schema.ts` (not imported from `@koi/hooks`) to keep `@koi/settings` free of peer L0u dependencies. The shape must stay in sync with `@koi/hooks`'s schema — a comment in both files enforces this.

```typescript
// Inline in schema.ts — must match @koi/hooks HookEventKind
interface HookCommand {
  readonly type: "command";
  readonly command: string;
  readonly timeout?: number;
}
```

**Validation strategy:** Invalid permission rule strings inside `allow`/`ask`/`deny` are filtered with a `ValidationError` warning rather than rejecting the whole file. One bad rule doesn't poison the layer.

---

## Merge Algorithm

Applied left-to-right across layers 1–4, then a policy enforcement pass for layer 5.

| Field type | Rule |
|-----------|------|
| Scalars (`defaultMode`, `theme`, `apiBaseUrl`, `enableAllProjectMcpServers`) | Last layer wins |
| Arrays (`allow`, `ask`, `deny`, `disabledMcpServers`, `additionalDirectories`) | Concatenate all layers, deduplicate |
| Objects (`env`, `hooks`) | Deep merge by key; last layer's value for a key wins |

**Policy enforcement pass (post-merge):**
After merging layers 1–4, policy (`layer 5`) is applied:
- Policy `deny` patterns are removed from merged `allow`/`ask` and prepended to `deny`
- Policy scalars override the merged value unconditionally
- Policy `env`/`hooks` keys override the merged value unconditionally

This guarantees policy can only tighten, never loosen, regardless of what lower layers set.

---

## Error Handling

| Layer | Parse failure behavior |
|-------|----------------------|
| user, project, local, flag | Skip layer, append `ValidationError[]`, continue loading |
| policy | `throw` with `code: "VALIDATION"` — caller exits with code 2 |

**Missing file = skip silently.** Absent settings files are normal (not a `ValidationError`). Only malformed JSON or Zod schema violations produce errors.

**`loadSettings()` never exits** — it returns `SettingsLoadResult` with collected errors for non-policy layers and throws only for policy failures. The caller (CLI / runtime) owns the exit.

---

## Public API

```typescript
// index.ts
export { loadSettings } from "./loader.js";
export { getSettingsJsonSchema, validateKoiSettings } from "./schema.js";
export { resolveSettingsPaths } from "./paths.js";
export type {
  KoiSettings,
  SettingsLayer,
  SettingsLoadOptions,
  SettingsLoadResult,
  ValidationError,
} from "./types.js";
```

---

## Testing Strategy

### Unit tests (colocated)

| File | Coverage |
|------|---------|
| `schema.test.ts` | Valid settings pass; invalid fields produce errors; bad rule strings get filtered-not-rejected |
| `merge.test.ts` | Arrays concat+dedup; scalars last-wins; objects deep-merge; policy post-pass tightens |
| `paths.test.ts` | Correct paths per layer on Linux/macOS; `cwd`/`homeDir` overrides respected |
| `loader.test.ts` | Each layer independently; each adjacent-pair merging; all-5-layer stack; policy parse error throws; missing file skips silently; `ValidationError[]` collected |

### Integration test (acceptance criterion)

In `packages/meta/runtime/src/__tests__/`:

> `koi start` picks up `.koi/settings.local.json` with a `deny` rule and `@koi/middleware-permissions` blocks the matching tool — verifies the full wiring from file → cascade → `SourcedRule[]` → middleware decision.

**Coverage target:** 80% lines/functions/statements (repo standard, enforced in `bunfig.toml`).

**Non-goal:** Settings tests assert `SettingsLoadResult` shape only — not downstream permission decisions. No mocking of `@koi/permissions` internals.

---

## Acceptance Criteria (from issue)

- [ ] `@koi/settings` L0u package with typed loader + Zod schema
- [ ] Cascade resolver with documented precedence + merge semantics
- [ ] Fail-closed on policy parse error (exit 2)
- [ ] Unit tests: each layer independently, each pair merging, policy always wins
- [ ] Integration test: `.koi/settings.local.json` deny rule blocks matching tool
- [ ] `docs/L2/settings.md` — schema, precedence, merge rules, examples
- [ ] Example `.koi/settings.json` in `examples/`
- [ ] `RuleSource` in `@koi/permissions` gains `"flag"` as 5th tier

---

## Out of Scope

- Settings UI/editor in TUI
- Migration from manifest-embedded permissions to settings
- Remote settings sync (org-managed via HTTP)
- Hot-reload / `watchSettings()` observable (defer to follow-up)
