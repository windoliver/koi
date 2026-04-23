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

### `resolveToolset(name, registry): Result<readonly string[], KoiError>`

Recursively resolves a named toolset to a flat, deduplicated list of tool names.
Detects and rejects cycles. Returns `{ ok: false }` for unknown names or cycles.

### `createBuiltinRegistry(): ToolsetRegistry`

Returns a `ReadonlyMap` of the four built-in presets. Callers may merge custom
toolsets on top.

### `mergeRegistries(...registries): ToolsetRegistry`

Merges multiple registries. Later entries win on name collision.

### Types (re-exported from `@koi/core`)

- `ToolsetDefinition` — `name`, `description`, `tools`, `includes`
- `ToolsetRegistry` — `ReadonlyMap<string, ToolsetDefinition>`

## Built-in Presets

| Name | Tools | Use case |
|------|-------|----------|
| `safe` | `web_search`, `web_fetch`, `memory_read` | Read-only web + memory — safe for untrusted channels (no writes, no deletes) |
| `developer` | `*` wildcard — all tools pass through | Full access for coding agents |
| `researcher` | `web_search`, `web_fetch`, `memory_read`, `read_file`, `glob`, `grep` | Read-only research — web, memory, filesystem (no writes) |
| `minimal` | `memory_read`, `ask_user` | Conversation only — read-only memory and user interaction |

`developer` uses the sentinel `"*"` — callers must handle this as "no filter" rather
than a literal tool name.

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
