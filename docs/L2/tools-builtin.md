# @koi/tools-builtin

Layer 2 package — Built-in tools (filesystem + search) implementing the L0 `Tool` contract.

## Purpose

Provides the core tools that every Koi agent needs:

### Filesystem Tools

- **read** — Read file content with optional line offset/limit
- **edit** — Search-and-replace with uniqueness preflight (oldText must exist exactly once)
- **write** — Create or overwrite files with optional directory creation

These are "primordial" tools — bundled at build time, highest trust level. They delegate all I/O to a `FileSystemBackend` (L0 contract), keeping the tools themselves pure argument validation + dispatch.

### Search Tools

- **Glob** — Fast file pattern matching with mtime sort
- **Grep** — Content search with rg backend + native literal fallback
- **ToolSearch** — Keyword/select search over available tool summaries

## Architecture

```
L0  @koi/core          Tool, FileSystemBackend, Result<T, KoiError>
L0u @koi/errors         mapFsError, KoiRuntimeError
L0u @koi/edit-match     cascading match strategies (future: edit uniqueness)
L0u @koi/file-resolution  path safety, token budgets (future: read enhancements)
        │
L2  @koi/tools-builtin  ← this package
        │
        ├── parse-args.ts         arg validation (no as-casts)
        ├── tools/
        │   ├── read.ts           createFsReadTool(backend, prefix, policy)
        │   ├── edit.ts           createFsEditTool(backend, prefix, policy)
        │   └── write.ts          createFsWriteTool(backend, prefix, policy)
        ├── glob-tool.ts          createGlobTool(config)
        ├── grep-tool.ts          createGrepTool(config)
        ├── tool-search-tool.ts   createToolSearchTool(config)
        └── builtin-search-provider.ts  ComponentProvider for search tools
```

## Filesystem Tool API

Each factory takes `(backend: FileSystemBackend, prefix: string, policy: ToolPolicy)` and returns a `Tool`.

#### `createFsReadTool`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | `string` | yes | File path to read |
| `offset` | `number` | no | Line offset to start reading from |
| `limit` | `number` | no | Maximum number of lines to read |
| `encoding` | `string` | no | File encoding (default: utf-8) |

#### `createFsEditTool`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | `string` | yes | Absolute path to the file |
| `edits` | `array` | yes | Array of `{ oldText, newText }` hunks |
| `dryRun` | `boolean` | no | Report changes without writing |

#### `createFsWriteTool`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | `string` | yes | Absolute path to the file |
| `content` | `string` | yes | Content to write |
| `createDirectories` | `boolean` | no | Create parent dirs if missing |
| `overwrite` | `boolean` | no | Overwrite existing file (default: false — fails closed) |

### Argument Parsing

Reusable parse helpers that return `ParseResult<T>` (discriminated union) instead of `as` casts:

- `parseString(args, key)` — required non-empty string
- `parseOptionalString(args, key)` — optional string
- `parseOptionalNumber(args, key)` — optional number
- `parseOptionalBoolean(args, key)` — optional boolean
- `parseArray(args, key)` — required array

## Search Tool API

### `createGlobTool(config: { cwd: string; policy?: ToolPolicy }): Tool`

Input: `{ pattern, path? }`. Returns `{ paths, truncated, total }` sorted by mtime descending.

### `createGrepTool(config: { cwd: string; policy?: ToolPolicy }): Tool`

Input: `{ pattern, path?, glob?, type?, output_mode?, multiline?, context?, head_limit?, offset?, -A?, -B?, -C?, -i?, -n? }`.
Returns `{ result, mode, truncated, warnings }`. Mode is `"rg"` or `"literal"`.

### `createToolSearchTool(config: { getTools: () => readonly ToolSummary[]; policy?: ToolPolicy }): Tool`

Input: `{ query, max_results? }`. Returns `ToolSummary[]`.

### `createBuiltinSearchProvider(config): ComponentProvider`

Bundles Glob, Grep, ToolSearch under `toolToken()` keys.

## Layer Compliance

- Imports: `@koi/core` only (L0)
- No imports from `@koi/engine` (L1) or peer L2 packages
- All tool properties are `readonly`
- Origin: `"primordial"` for all built-in tools
