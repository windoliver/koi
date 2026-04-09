# @koi/plugins

**Layer:** L2  
**Location:** `packages/lib/plugins`  
**Purpose:** Plugin manifest validation, multi-source discovery, and in-memory registry.

Discovers plugins from three source tiers (bundled, user, managed), validates `plugin.json` manifests via Zod, and provides a `Resolver<PluginMeta, LoadedPlugin>`-conformant registry with path containment enforcement.

## Architecture

```
createPluginRegistry(config?)
  ├── discover()       ← walks roots, reads plugin.json → PluginMeta[]
  ├── load(id)         ← resolve paths + containment check → LoadedPlugin
  ├── invalidate()     ← clear cache, next discover() re-scans
  └── errors()         ← per-plugin discovery errors from last scan
```

### Two-Phase Progressive Loading

`discover()` reads `plugin.json` manifests only — returns `PluginMeta` with name, version, description, source tier, and availability. No path resolution runs.

`load(id)` promotes a discovered plugin to `LoadedPlugin` by resolving all relative paths (skills, hooks, mcpServers) via `realpath()` and asserting containment within the plugin's root directory. Results are cached.

### Three-Source Precedence

Plugins are discovered from three tiers. When two tiers define a plugin with the same name, the higher-priority tier wins (shadowing).

| Tier | Purpose | Priority |
|------|---------|----------|
| `managed` | Organization-managed plugins | Highest |
| `user` | User-installed plugins | Middle |
| `bundled` | Package-shipped plugins | Lowest |

Missing root directories are silently skipped (not an error).

### Resolver Contract Conformance

`PluginRegistry` implements `Resolver<PluginMeta, LoadedPlugin>` from `@koi/core`:

- `discover()` returns lightweight metadata (no I/O beyond manifest read)
- `load(id)` returns the full resolved plugin with validated paths
- Inflight promise deduplication on both methods

### Path Containment (fail-closed)

During `load()`, all relative paths from the manifest are resolved via `realpath()` and checked against the plugin's `dirPath`. Symlink escapes and `../` traversal after resolution produce a `PERMISSION` error. This is fail-closed: if resolution fails, the path is rejected.

### Availability Gating

The optional `isAvailable(manifest)` callback is evaluated at discovery time. The result is stored in `PluginMeta.available` as informational metadata. `discover()` filters to `available === true` plugins. Callers needing the full set (including unavailable) can access the raw discovery result.

### Partial Success

Invalid manifests in one plugin do not block discovery of others. Per-plugin errors are collected in `PluginError` entries, accessible via `registry.errors()`.

## Public API

```typescript
import { createPluginRegistry } from "@koi/plugins";
import type {
  PluginRegistry,
  PluginMeta,
  LoadedPlugin,
  PluginManifest,
  PluginRegistryConfig,
} from "@koi/plugins";
```

### `createPluginRegistry(config?: PluginRegistryConfig): PluginRegistry`

Factory. Creates an instance-scoped registry. Discovery cache, load cache, and config all live inside the instance — no global state.

### `validatePluginManifest(raw: unknown): Result<PluginManifest, KoiError>`

Validates a raw object against the `plugin.json` Zod schema. Returns typed `Result`.

### `pluginId(name: string): PluginId`

Branded type constructor for plugin identifiers.

## Dependencies

- `@koi/core` (L0) — `Result`, `KoiError`, `Resolver`
- `@koi/errors` (L0u) — error factories
- `@koi/validation` (L0u) — `validateWith()`
- `zod` — manifest schema

## Manifest Schema

```json
{
  "name": "my-plugin",
  "version": "1.0.0",
  "description": "A sample plugin",
  "author": "Example",
  "keywords": ["sample"],
  "skills": ["./skills/greeting"],
  "hooks": "./hooks/hooks.json",
  "mcpServers": "./.mcp.json",
  "middleware": ["my-custom-middleware"]
}
```

Required fields: `name` (kebab-case), `version` (semver), `description`.
All other fields are optional. Path fields (`skills`, `hooks`, `mcpServers`) are opaque relative paths — interpretation is delegated to their respective subsystems.

## Lifecycle Operations

Plugin lifecycle is managed through `@koi/plugins` CRUD functions:

| Function | Purpose |
|----------|---------|
| `installPlugin(config, sourcePath)` | Copy plugin from local path into `userRoot/<name>/` with TOCTOU protection |
| `removePlugin(config, name)` | Clean disabled state, then delete plugin directory |
| `enablePlugin(config, name)` | Remove from disabled set (idempotent, rejects non-existent names) |
| `disablePlugin(config, name)` | Add to disabled set (idempotent, rejects non-existent names) |
| `updatePlugin(config, name, sourcePath)` | Rollback-safe swap with backup directory + post-copy validation |
| `listPlugins(config)` | Discover all plugins with enabled/disabled status overlay |
| `createGatedRegistry(registryConfig, userRoot)` | Factory returning a `PluginRegistry` that gates discovery/load by disabled state |
| `recoverOrphanedUpdates(userRoot)` | Restores `.backup` dirs from interrupted updates, cleans `.updating` staging |

### State persistence

Disabled-plugin state is stored in `<userRoot>/state.json` as `{ "disabled": ["plugin-a", ...] }`. All plugins are enabled by default. Writes use per-write unique temp files + atomic rename for crash safety. The `createGatedRegistry` re-reads state on every `discover()` and `load()` call, preserving the last known disabled set on read failures.

### Name validation

All lifecycle operations validate plugin names via `isPluginId()` (kebab-case regex) before any filesystem operations, preventing path traversal attacks.

### CLI integration

The `koi plugin` CLI command exposes all lifecycle operations:

```
koi plugin install <path>         Install from local directory
koi plugin remove <name>          Remove installed plugin
koi plugin enable <name>          Enable a disabled plugin
koi plugin disable <name>         Disable a plugin
koi plugin update <name> <path>   Update with rollback-safe swap
koi plugin list [--json]          List plugins with status
```

## Session Activation

When the TUI or CLI `start` command launches a session, enabled plugins automatically contribute their components via `loadPluginComponents()` (in `plugin-activation.ts`):

- **Skills**: Plugin skill directories are scanned for `SKILL.md` files, parsed into `SkillMetadata`, and registered via `skillsRuntime.registerExternal()`
- **Hooks**: Plugin `hooks.json` configs are loaded via `loadHooks()` and merged with user hooks before `createHookMiddleware()`
- **MCP servers**: Plugin `.mcp.json` configs are loaded via `loadMcpJsonFile()`, connections created, and added as providers to `createKoi()`
- **Middleware**: Names are collected but not resolved (no factory registry yet) — logged as a warning
