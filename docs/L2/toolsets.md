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
| `safe` | `web_search`, `web_fetch`, `memory_read`, `memory_write`, `memory_delete` | No shell, no file write — safe for untrusted channels |
| `developer` | `*` wildcard — all tools pass through | Full access for coding agents |
| `researcher` | `web_search`, `web_fetch`, `memory_read`, `memory_write`, `memory_delete`, `read_file`, `glob`, `grep` | Research without mutation |
| `minimal` | `memory_read`, `memory_write`, `memory_delete`, `ask_user` | Conversation only |

`developer` uses the sentinel `"*"` — callers must handle this as "no filter" rather
than a literal tool name.

## Manifest Integration

```yaml
# Single toolset
toolsets:
  - developer

# Composed
toolsets:
  - researcher
  - memory
tools:
  - custom_tool
```

The assembler resolves each name in `toolsets`, unions the results, then merges
the explicit `tools` list on top.

## Spawn Narrowing

In `ManifestSpawnConfig.tools`, set `toolset` instead of (or in addition to) `list`:

```yaml
spawn:
  tools:
    policy: allowlist
    toolset: safe
```

The spawn engine resolves `toolset` to a flat list and uses it as the effective `list`.
`toolset` and `list` are merged (union) when both are present.

## Cycle Detection

Toolset composition is validated at resolution time:

```
safe → (no includes)                   ✓
researcher → memory → (no includes)    ✓  (if memory existed)
a → b → a                             ✗  cycle — error returned
```

Resolution visits each toolset once and returns an error if a name is encountered
a second time in the same resolution path.
