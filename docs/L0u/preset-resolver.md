# @koi/preset-resolver — Generic 3-Layer Config Resolution (L0u)

Building blocks for the "defaults → preset → user overrides" pattern used across Koi meta-packages. Provides `deepMerge()`, `lookupPreset()`, and `resolvePreset()` as composable utilities.

---

## Why It Exists

Seven L3 meta-packages (retry-stack, quality-gate, governance, ipc-stack, goal-stack, context-arena, and others) all implement the same 3-layer config resolution pattern:

1. **Defaults** — hardcoded base config
2. **Preset** — named preset that overrides defaults (e.g., "light", "standard", "aggressive")
3. **User overrides** — explicit user config that wins over everything

Before this package, each meta-package duplicated the preset lookup logic (`config.preset ?? defaultPreset` → `SPECS[preset]`) and `@koi/config` owned a `deepMerge()` utility that logically belonged at the L0u layer. This extraction:

- Eliminates duplicated preset resolution across 6+ packages
- Moves `deepMerge()` to L0u where it belongs (zero deps, pure utility)
- Provides both a high-level `resolvePreset()` for simple cases and low-level building blocks for packages with custom validation

---

## What This Enables

### For package authors

- **Simple packages** call `resolvePreset(defaults, specs, defaultPreset, config)` and get a fully merged config in one call.
- **Complex packages** use `lookupPreset()` to resolve the preset name, then apply domain-specific validation before merging with `deepMerge()`.
- **Any package** can use `deepMerge()` standalone for recursive plain-object merging without pulling in `@koi/config` and its Zod/validation dependencies.

### For the architecture

- `deepMerge` is now L0u (zero deps) instead of being locked inside L2 `@koi/config` (which depends on Zod). Any L0u, L1, or L2 package can use it.
- The 3-layer pattern is standardized — new meta-packages get consistent config resolution for free.
- `@koi/config` re-exports `deepMerge` from this package for backwards compatibility; existing consumers are unaffected.

---

## API

### `deepMerge<T>(base, override): T`

Deeply merges `override` into `base`, returning a new object. Never mutates inputs.

- Plain objects are merged recursively
- Arrays are replaced wholesale (not concatenated)
- Primitives from override win
- `undefined` in override is skipped (preserves base value)
- Keys absent from `base` are ignored (no key injection)

### `lookupPreset<P, S>(specs, preset, defaultPreset): { preset, spec }`

Resolves a preset name from a frozen registry, falling back to a default when `preset` is `undefined`.

| Parameter | Type | Description |
|-----------|------|-------------|
| `specs` | `Readonly<Record<P, S>>` | Frozen registry of preset specifications |
| `preset` | `P \| undefined` | User-selected preset (or undefined for default) |
| `defaultPreset` | `NoInfer<P>` | Fallback preset name |

Returns `{ preset: P, spec: Readonly<S> }`.

### `resolvePreset<T, P>(defaults, specs, defaultPreset, config): { preset, resolved }`

Full 3-layer merge in one call:

1. Looks up the preset (or falls back to `defaultPreset`)
2. Deep-merges the preset spec over `defaults`
3. Deep-merges user `config` over the result

The `preset` key in `config` is used for lookup but excluded from the merge (deepMerge only iterates base keys).

### `DeepPartial<T>`

Recursive partial type — makes all nested properties optional and readonly.

---

## Usage Patterns

### Simple: one-call resolution

```typescript
import { resolvePreset } from "@koi/preset-resolver";

const { preset, resolved } = resolvePreset(
  DEFAULTS,           // base config with all keys
  PRESET_SPECS,       // Record<PresetName, DeepPartial<Config>>
  "standard",         // default preset
  userConfig,         // { preset?: PresetName } & DeepPartial<Config>
);
```

### Building blocks: custom validation between layers

```typescript
import { lookupPreset, deepMerge } from "@koi/preset-resolver";

const { preset, spec } = lookupPreset(SPECS, config.preset, "open");

// Custom validation before merge
if (config.permissions && config.permissionRules) {
  throw new Error("Cannot provide both");
}

// Manual field-by-field resolution
return {
  preset,
  permissions: config.permissions ?? spec.permissions,
  audit: config.audit ?? spec.audit,
};
```

---

## Layer Compliance

```
L0u @koi/preset-resolver
    zero dependencies — pure TypeScript utility
    importable by L0u, L1, L2, and L3 packages
```

---

## File Structure

```
packages/lib/preset-resolver/
├── package.json          # zero deps
├── tsconfig.json
├── tsup.config.ts
└── src/
    ├── index.ts              # Public exports
    ├── types.ts              # DeepPartial<T>
    ├── deep-merge.ts         # deepMerge()
    ├── deep-merge.test.ts    # 12 tests
    ├── lookup-preset.ts      # lookupPreset()
    ├── lookup-preset.test.ts # 4 tests
    ├── resolve-preset.ts     # resolvePreset()
    └── resolve-preset.test.ts # 6 tests
```

---

## Consumers

| Package | Layer | Usage |
|---------|-------|-------|
| `@koi/config` | L2 | Re-exports `deepMerge` (backwards compat) |
| `@koi/retry-stack` | L3 | `lookupPreset()` for preset resolution |
| `@koi/quality-gate` | L3 | `lookupPreset()` for preset resolution |
| `@koi/governance` | L3 | `lookupPreset()` + custom validation |
| `@koi/ipc-stack` | L3 | `lookupPreset()` + custom validation |
| `@koi/goal-stack` | L3 | `lookupPreset()` + custom validation |
| `@koi/context-arena` | L3 | `lookupPreset()` via `computePresetBudget()` |
