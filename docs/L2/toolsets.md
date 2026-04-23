# @koi/toolsets

Named, composable tool presets for agents, spawn, and channels.

## Layer

L2 — depends on `@koi/core` (L0) only.

## Purpose

Replaces ad-hoc tool lists with reusable named presets. A toolset is a named group
of tool names that can reference other toolsets (composition). Manifests and spawn
configurations reference toolsets by name; the resolver expands them to flat tool lists
at assembly time.

> **Scope: library infrastructure only.**
> This package is a pure resolution helper — it does NOT enforce tool access at runtime.
> The assembler/engine does not yet call `resolveToolset` automatically; callers must
> wire the resolved policy into `SpawnRequest.toolAllowlist` themselves.
> Do not treat a named preset as an enforced permission boundary until the assembler
> integration is complete. See "Manifest Integration" below.

## Public API

### `resolveToolset(name, registry): Result<ToolsetResolution, KoiError>`

Recursively resolves a named toolset to an explicit policy:
- `{ mode: "all" }` — no filter (agent receives every tool)
- `{ mode: "allowlist", tools: string[] }` — explicit tool allowlist

Detects and rejects cycles. Returns `{ ok: false }` for unknown names, cycles,
depth limit exceeded, or any composition that inherits a wildcard into a non-wildcard
preset — wildcard inheritance always fails closed.

Does **not** validate tool names against the live runtime registry — callers must
do that at assembly time if strict validation is required.

### `resolutionToToolAllowlist(resolution): readonly string[] | undefined`

Converts a `ToolsetResolution` to the value expected by `SpawnRequest.toolAllowlist`:
- `{ mode: "all" }` → `undefined` (omit `toolAllowlist` to grant full access)
- `{ mode: "allowlist", tools }` → `tools`

Use this adapter instead of passing `result.value` directly — `ToolsetResolution` is
a discriminated union and cannot be assigned to `toolAllowlist: readonly string[]` directly.

### `createBuiltinRegistry(): ToolsetRegistry`

Returns a `ReadonlyMap` of the four built-in presets. Callers may merge custom
toolsets on top with `mergeRegistries`.

### `mergeRegistries(registries, opts?): ToolsetRegistry`

Merges an array of registries into one.

**Default (fail-closed):** throws if any name appears more than once — preset names
are authorization identifiers and silent shadowing can widen an agent's tool surface.

Pass `{ allowOverrides: true }` to enable last-wins semantics when intentional override
is needed (e.g., operator customization layer replacing a built-in preset).

```typescript
// Safe: distinct names, no collision
const merged = mergeRegistries([builtinReg, customReg]);

// Intentional override of a built-in
const merged = mergeRegistries([builtinReg, operatorReg], { allowOverrides: true });
```

### Types (re-exported from `@koi/core`)

- `ToolsetDefinition` — `name`, `description`, `tools`, `includes`
- `ToolsetRegistry` — `ReadonlyMap<string, ToolsetDefinition>`
- `ToolsetResolution` — `{ mode: "all" } | { mode: "allowlist"; tools: string[] }`

### Types (from `@koi/toolsets`)

- `MergeRegistriesOptions` — `{ allowOverrides?: boolean }`

## Built-in Presets

| Name | Tools | Use case |
|------|-------|----------|
| `safe` | `web_fetch`, `Glob`, `Grep`, `fs_read` | Read-only web + filesystem, no shell, no writes |
| `developer` | `*` → `{ mode: "all" }` | Full access for coding agents |
| `researcher` | `web_fetch`, `Glob`, `Grep`, `fs_read`, `ToolSearch` | Research without mutation — extends safe with tool discovery |
| `minimal` | `AskUserQuestion` | Conversation only — no tool access beyond user interaction |

> **`safe` is NOT an untrusted-channel sandbox.** `fs_read` can read arbitrary workspace paths.
> It is a developer-facing read-only boundary, not a privilege boundary for external/untrusted input.
> For genuinely untrusted callers, omit filesystem tools entirely and use a custom preset.

Tool names match Koi's default wiring: `Glob`, `Grep`, `ToolSearch`, `AskUserQuestion` (PascalCase);
`fs_read` (prefix `"fs"` from `@koi/tools-builtin`); `web_fetch` (prefix `"web"` from `@koi/tools-web`).
`"*"` in `developer` is a sentinel: `resolveToolset` validates it is the sole tool with no `includes`,
then returns `{ mode: "all" }` — it cannot be combined with other tools or accidentally smuggled via composition.
Web tools use the `web_` prefix from `@koi/tools-web` configured with `prefix: "web"`.
Custom MCP or forged tools have different names — extend the registry with custom presets.

`developer` stores `"*"` internally; `resolveToolset` converts it to `{ mode: "all" }` so
callers receive an explicit tagged result and cannot accidentally use `"*"` as a tool name.

## Manifest Integration

> **Not yet wired.** `AgentManifest.toolsets` and `ManifestSpawnConfig.tools.toolset` schema fields
> will be added once the assembler calls `resolveToolset` and enforces the resulting allowlist.
> Until then this package is a **library helper only** — the runtime does not automatically
> apply any preset to agent tool access.

Programmatic usage until assembly wiring is complete:

```typescript
const reg = createBuiltinRegistry();
const result = resolveToolset("safe", reg);
if (result.ok) {
  // Use resolutionToToolAllowlist to convert — do NOT pass result.value directly
  // to toolAllowlist; ToolsetResolution is a discriminated union, not string[].
  await spawn({ ...req, toolAllowlist: resolutionToToolAllowlist(result.value) });
}
```

`resolutionToToolAllowlist` handles both modes correctly:
- `safe`/`researcher`/`minimal` → returns `string[]`
- `developer` (`mode: "all"`) → returns `undefined` (omit filter = full access)

## Cycle Detection

Toolset composition is validated at resolution time:

```
safe → (no includes)                   ✓
researcher → memory → (no includes)    ✓  (if memory existed)
a → b → a                             ✗  cycle — error returned
```

Resolution visits each toolset once and returns an error if a name is encountered
a second time in the same resolution path.

## Wildcard Safety

`"*"` in a toolset definition is a sentinel that resolves to `{ mode: "all" }`. Safety rules:

- `"*"` must be the sole tool in its definition with no `includes`
- Any preset that includes another preset that resolves to `mode: "all"` is rejected
- Wildcard inheritance is always rejected regardless of depth
- Resolution depth is capped at 50 levels to prevent stack overflow

These rules ensure that a caller cannot accidentally receive `mode: "all"` through
composition when it expects a named allowlist.
