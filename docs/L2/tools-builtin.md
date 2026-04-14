# @koi/tools-builtin

Layer 2 package — Built-in tools (filesystem, search, and interaction) implementing the L0 `Tool` contract.

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

### Interaction Tools

- **TodoWrite** — In-conversation to-do list management. Model provides the full replacement list on each call. Auto-clears when all items reach `completed` status.
- **EnterPlanMode** — Read-only planning gate. Transitions the harness permission mode to `plan` (no file writes/edits/Bash until the plan is approved). Main-thread only — blocked with `FORBIDDEN` when called from a spawned agent context. Disabled in channel mode (no TUI dialog available).
- **ExitPlanMode** — Plan approval with `allowedPrompts`. Presents plan for user approval on the main-thread path (policy-gated: `ask`). On the swarm-teammate path, writes a `plan_approval_request` to the team lead mailbox and returns `awaitingLeaderApproval: true`. Requires non-empty `plan_content` on all paths.
- **AskUserQuestion** — Structured elicitation. Presents 1–4 predefined-choice questions to the user and waits for answers. Stateless: delegates all pause/answer logic to the `elicit` callback provided by the harness. Disabled in channel mode. Omitted entirely when `elicit` is not wired.

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
        │   ├── write.ts          createFsWriteTool(backend, prefix, policy)
        │   ├── todo.ts           createTodoTool(config)
        │   ├── plan-mode.ts      createEnterPlanModeTool(config) + createExitPlanModeTool(config)
        │   └── ask-user.ts       createAskUserTool(config)
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

## Interaction Tool API

All interaction tool factories use `DEFAULT_UNSANDBOXED_POLICY` by default (overridable via `policy` in the config).

### `createTodoTool(config: TodoToolConfig): Tool`

Input: `{ todos: TodoItem[] }` — complete replacement list.

```typescript
interface TodoItem {
  readonly id: string;
  readonly content: string;
  readonly status: "pending" | "in_progress" | "completed";
  readonly activeForm?: string; // present-continuous verb for spinner, e.g. "Running tests"
}
```

Returns `{ todos, cleared }`. `cleared: true` when all items were `completed` and the list was auto-wiped.

State is injected via `getItems`/`setItems` callbacks — the tool itself holds no state. Call `setItems([])` on session reset.

### `createEnterPlanModeTool(config: EnterPlanModeConfig): Tool`

Input: `{}` (no args). Calls `config.enterPlanMode()` on success. Returns an error if:
- `isAgentContext()` returns `true` — `FORBIDDEN`
- `isChannelsActive()` returns `true` — `UNAVAILABLE`
- Already in plan mode — `CONFLICT`

### `createExitPlanModeTool(config: ExitPlanModeConfig): Tool`

Input: `{ plan_content: string, allowedPrompts?: { tool: "Bash", prompt: string }[] }`.

- Main-thread path: policy-gated (`ask`) — harness presents plan for user approval. After approval, calls `exitPlanMode()` and `onApproved(allowedPrompts)`.
- Swarm-teammate path (`isTeammate && isPlanModeRequired`): writes `plan_approval_request` to team lead mailbox via `writeToMailbox`, returns `{ awaitingLeaderApproval: true, requestId }`.

### `createAskUserTool(config: AskUserToolConfig): Tool`

Input: `{ questions: ElicitationQuestion[] }` (1–4 questions, each with 2+ options).

Delegates to `config.elicit(questions)` — the harness is responsible for pausing the agent loop and resolving with user answers. Returns `{ answers: [{ question, selected, freeText? }] }`.

Omit from the tool set entirely (don't call the factory) when `elicit` is not available. `createInteractionProvider` (in `@koi/runtime`) handles this automatically.

## Layer Compliance

- Imports: `@koi/core` only (L0)
- No imports from `@koi/engine` (L1) or peer L2 packages
- All tool properties are `readonly`
- Origin: `"primordial"` for all built-in tools


## Changelog

- **Path-aware filesystem permissions** — fs_read for out-of-workspace paths triggers permission prompt instead of silent NOT_FOUND.
