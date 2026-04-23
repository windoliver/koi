# @koi/toolsets

Named, composable tool presets for agents, spawn, and channels.

## Layer

L2 — depends on `@koi/core` (L0) only.

## Purpose

Replaces ad-hoc tool lists with reusable named presets. A toolset is a named group
of tool names that can reference other toolsets (composition). Manifests and spawn
configurations reference toolsets by name; the resolver expands them to flat tool lists
at assembly time.

## Public API

### `resolveToolset(name, registry): Result<ToolsetResolution, KoiError>`

Recursively resolves a named toolset to an explicit policy:
- `{ mode: "all" }` — no filter (agent receives every tool)
- `{ mode: "allowlist", tools: string[] }` — explicit tool allowlist

Detects and rejects cycles. Returns `{ ok: false }` for unknown names or cycles.
Does **not** validate tool names against the live runtime registry — callers must
do that at assembly time if strict validation is required.

### `createBuiltinRegistry(): ToolsetRegistry`

Returns a `ReadonlyMap` of the four built-in presets. Callers may merge custom
toolsets on top.

### `mergeRegistries(...registries): ToolsetRegistry`

Merges multiple registries. Later entries win on name collision.

### Types (re-exported from `@koi/core`)

- `ToolsetDefinition` — `name`, `description`, `tools`, `includes`
- `ToolsetRegistry` — `ReadonlyMap<string, ToolsetDefinition>`
- `ToolsetResolution` — `{ mode: "all" } | { mode: "allowlist"; tools: string[] }`

## Built-in Presets

| Name | Tools | Use case |
|------|-------|----------|
| `safe` | `web_fetch`, `Glob`, `Grep`, `fs_read` | Read-only web + filesystem, no shell, no writes |
| `developer` | `*` → `{ mode: "all" }` | Full access for coding agents |
| `researcher` | `web_fetch`, `Glob`, `Grep`, `fs_read`, `ToolSearch` | Research without mutation — extends safe with tool discovery |
| `minimal` | `AskUserQuestion` | Conversation only — no tool access beyond user interaction |

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
> Callers can use `resolveToolset` + `toolAllowlist` on `SpawnRequest` directly today.

```typescript
// Programmatic usage until assembly wiring is complete
const reg = createBuiltinRegistry();
const result = resolveToolset("safe", reg);
if (result.ok) {
  await spawn({ ...req, toolAllowlist: result.value });
}
```

## Cycle Detection

Toolset composition is validated at resolution time:

```
safe → (no includes)                   ✓
researcher → memory → (no includes)    ✓  (if memory existed)
a → b → a                             ✗  cycle — error returned
```

Resolution visits each toolset once and returns an error if a name is encountered
a second time in the same resolution path.
