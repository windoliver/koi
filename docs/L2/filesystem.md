# @koi/filesystem — Cross-Engine Filesystem Abstraction

Wraps a `FileSystemBackend` as 5 Koi Tool components: read, write, edit, list, and search. Optionally attaches a 6th tool — `fs_semantic_search` — when a `Retriever` is provided for ranked semantic search over indexed files. One factory call attaches all tools to any agent via ECS — both `engine-claude` and `engine-pi` discover them with `agent.query<Tool>("tool:")` and zero engine changes.

Exports a `BrickDescriptor` for manifest auto-resolution: the resolve layer validates filesystem options (operations, prefix, trustTier) from `koi.yaml` at startup.

---

## Why It Exists

Agents that work with code need filesystem access: read files, write changes, edit in place, list directories, search for patterns. Each engine adapter would need its own filesystem integration, leading to duplicated tool schemas, inconsistent error handling, and no middleware interception.

`@koi/filesystem` solves this by defining a `FileSystemBackend` interface (in L0) and wrapping it as Koi `Tool` components (in L2). The `ComponentProvider` pattern means any engine adapter discovers these tools automatically. The `BrickDescriptor` enables manifest-driven validation and discovery.

---

## What This Enables

### Agent-Driven File Operations

```
                      ┌──────────────────────────────────────────────┐
                      │           Your Koi Agent (YAML)              │
                      │  name: "code-assistant"                      │
                      │  model: anthropic:claude-sonnet              │
                      │  tools: ["@koi/filesystem"]                  │
                      └──────────────────┬───────────────────────────┘
                                         │
                    ┌────────────────────▼─────────────────────────┐
                    │           createKoi() — L1 Engine             │
                    │  ┌──────────────────────────────────────────┐ │
                    │  │ Middleware Chain                          │ │
                    │  │  audit → permissions → sandbox → ...     │ │
                    │  └──────────────────────────────────────────┘ │
                    │  ┌──────────────────────────────────────────┐ │
                    │  │ Engine Adapter (Loop / Pi / Claude)      │ │
                    │  │  → LLM calls with tool schemas           │ │
                    │  └──────────────────────────────────────────┘ │
                    └────────────────────┬─────────────────────────┘
                                         │
              ┌──────────────────────────▼──────────────────────────────┐
              │         createFileSystemProvider() — THIS PACKAGE       │
              │                                                         │
              │  ONE factory → 5 Tool components → ECS-attached         │
              │  + optional fs_semantic_search (when retriever given)  │
              │                                                         │
              │  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐  │
              │  │ fs_read  │ │ fs_write │ │ fs_edit  │ │ fs_list  │  │
              │  └────┬─────┘ └────┬─────┘ └────┬─────┘ └────┬─────┘  │
              │       │            │             │             │        │
              │  ┌────▼────────────▼─────────────▼─────────────▼─────┐ │
              │  │  fs_search                                        │ │
              │  └───────────────────────┬───────────────────────────┘ │
              │                          │                             │
              │  ┌───────────────────────▼───────────────────────────┐ │
              │  │  FileSystemBackend (injected interface)           │ │
              │  │  ● read(), write(), edit(), list(), search()     │ │
              │  │  ● Concrete impls: local disk, S3, in-memory...  │ │
              │  │  ● Mockable for tests (inject via interface)     │ │
              │  └───────────────────────────────────────────────────┘ │
              │                                                         │
              │  ┌─────────────────────────────────────────────────────┐ │
              │  │  fs_semantic_search  (optional — when retriever)   │ │
              │  │  ● Natural-language ranked search over indexed     │ │
              │  │    files via Retriever from @koi/search-provider   │ │
              │  │  ● BM25 (local), Nexus (remote), or custom impl   │ │
              │  └─────────────────────────────────────────────────────┘ │
              └──────────────────────────────────────────────────────────┘
```

### Before vs After (BrickDescriptor)

```
BEFORE: filesystem in koi.yaml — no validation, not discoverable
═══════════════════════════════════════════════════════════════

  koi.yaml:
  ┌─────────────────────────────────────────────────────┐
  │ tools:                                               │
  │   - name: "@koi/filesystem"                          │
  │     trustTier: "sandbo"   ← typo, silently ignored   │
  │     operations: ["reed"]  ← typo, silently ignored   │
  └─────────────────────────────────────────────────────┘

  resolve layer:
    "@koi/filesystem" → no descriptor found → skip validation


AFTER: filesystem has BrickDescriptor — validated at startup
════════════════════════════════════════════════════════════

  koi.yaml:
  ┌─────────────────────────────────────────────────────┐
  │ tools:                                               │
  │   - name: "@koi/filesystem"                          │
  │     trustTier: "sandbo"   ← VALIDATION error!        │
  │     operations: ["reed"]  ← VALIDATION error!        │
  └─────────────────────────────────────────────────────┘

  resolve layer:
    "@koi/filesystem" → descriptor found
    → aliases: ["filesystem", "fs"]
    → optionsValidator: checks operations, prefix, trustTier
    → error: 'filesystem.trustTier must be one of: sandbox, verified, promoted'
```

---

## Architecture

`@koi/filesystem` is an **L2 feature package**.

```
┌───────────────────────────────────────────────────────┐
│  @koi/filesystem  (L2)                                │
│                                                       │
│  constants.ts              ← operations, SDK mappings │
│  descriptor.ts             ← BrickDescriptor          │
│  fs-component-provider.ts  ← ComponentProvider        │
│  index.ts                  ← public API surface       │
│                                                       │
│  tools/                                               │
│    read.ts                 ← fs_read                  │
│    write.ts                ← fs_write                 │
│    edit.ts                 ← fs_edit                  │
│    list.ts                 ← fs_list                  │
│    search.ts               ← fs_search                │
│    semantic-search.ts      ← fs_semantic_search       │
│                                                       │
├───────────────────────────────────────────────────────┤
│  External deps: NONE                                  │
│                                                       │
├───────────────────────────────────────────────────────┤
│  Internal deps                                        │
│  ● @koi/core (L0) — Tool, ComponentProvider, types    │
│  ● @koi/scope (L0u) — scoped filesystem wrapper       │
│  ● @koi/resolve (L0u) — BrickDescriptor type          │
│  ● @koi/search-provider (L0u) — Retriever contract    │
│                                                       │
│  Dev-only                                             │
│  ● @koi/test-utils — mock backends                    │
└───────────────────────────────────────────────────────┘
```

### Layer Position

```
L0  @koi/core ────────────────────────────────────────┐
    Tool, ComponentProvider, FileSystemBackend,         │
    KoiError, Result, TrustTier                         │
                                                        │
L0u @koi/scope ───────────────────────────────────────┤
    createScopedFileSystem                              │
                                                        │
L0u @koi/resolve ─────────────────────────────────────┤
    BrickDescriptor                                     │
                                                        │
L0u @koi/search-provider ────────────────────────────┤
    Retriever interface                                 │
                                                        │
                                                        ▼
L2  @koi/filesystem ◄──────────────────────────────────┘
    imports from L0 + L0u only
    ✗ never imports @koi/engine (L1)
    ✗ never imports peer L2 packages
    ✗ zero external npm dependencies
    ✓ All interface properties readonly
```

### Internal Structure

```
createFileSystemProvider(config)
│
├── config.backend       → FileSystemBackend (injected)
├── config.prefix        → "fs" (default)
├── config.trustTier     → "verified" (default)
├── config.operations    → all 5 (default)
├── config.scope?        → FileSystemScope (optional root + readOnly)
├── config.retriever?    → Retriever (optional — enables fs_semantic_search)
│
└── attach(agent) → Map<SubsystemToken, Tool>
    │
    ├── toolToken("fs_read")    → createFsReadTool(backend, prefix, trustTier)
    ├── toolToken("fs_write")   → createFsWriteTool(backend, prefix, trustTier)
    ├── toolToken("fs_edit")    → createFsEditTool(backend, prefix, trustTier)
    ├── toolToken("fs_list")    → createFsListTool(backend, prefix, trustTier)
    ├── toolToken("fs_search")  → createFsSearchTool(backend, prefix, trustTier)
    ├── toolToken("fs_semantic_search")  → (only when retriever provided)
    └── FILESYSTEM token        → backend (service singleton for middleware access)


descriptor (BrickDescriptor<ComponentProvider>)
│
├── kind: "tool"
├── name: "@koi/filesystem"
├── aliases: ["filesystem", "fs"]
├── optionsValidator:
│     ├── operations? → array of valid ops (read, write, edit, list, search)
│     ├── prefix?     → string
│     └── trustTier?  → "sandbox" | "verified" | "promoted"
│
└── factory: always throws (FileSystemBackend cannot be created from YAML)
```

---

## Tools Reference

### 5 Standard Tools + 1 Optional

```
╔═══════════════════════╦═══════════╦══════════════════════════════════════════════════╗
║ Tool                  ║ Trust     ║ Purpose                                          ║
╠═══════════════════════╬═══════════╬══════════════════════════════════════════════════╣
║ fs_read               ║ verified  ║ Read file contents (with optional offset/limit) ║
║ fs_write              ║ verified  ║ Write or create a file                          ║
║ fs_edit               ║ verified  ║ Apply edits to a file (search/replace)          ║
║ fs_list               ║ verified  ║ List directory entries (files, dirs, symlinks)   ║
║ fs_search             ║ verified  ║ Search file contents by pattern (regex)         ║
╠═══════════════════════╬═══════════╬══════════════════════════════════════════════════╣
║ fs_semantic_search    ║ verified  ║ Ranked semantic search (requires retriever)     ║
╚═══════════════════════╩═══════════╩══════════════════════════════════════════════════╝
```

### Input Schemas

```
fs_read
  ├── path          string    (required) File path to read
  ├── offset?       number    Line offset to start reading
  └── limit?        number    Max lines to return

fs_write
  ├── path          string    (required) File path to write
  └── content       string    (required) File content

fs_edit
  ├── path          string    (required) File path to edit
  ├── edits         array     (required) Array of { oldText, newText } pairs
  └── dryRun?       boolean   Preview changes without writing

fs_list
  ├── path          string    (required) Directory path to list
  ├── recursive?    boolean   List recursively
  └── pattern?      string    Glob filter pattern

fs_search
  ├── pattern       string    (required) Search pattern (regex)
  ├── path?         string    Directory to search in
  ├── include?      string    File glob to include
  └── maxResults?   number    Max matches to return

fs_semantic_search  (optional — only when retriever provided)
  ├── query         string    (required) Natural-language search query
  ├── limit?        number    Max results to return (default: 10)
  └── minScore?     number    Minimum relevance score threshold (0–1)
```

---

## BrickDescriptor

The `descriptor` enables manifest auto-resolution from `koi.yaml`:

```yaml
# koi.yaml — filesystem options are validated at startup
tools:
  - name: "@koi/filesystem"    # or alias: "filesystem" or "fs"
    operations: [read, list, search]   # subset of ops
    prefix: "file"                      # → file_read, file_list, file_search
    trustTier: "sandbox"                # override default
```

### What the descriptor validates

| Field | Type | Valid values |
|-------|------|-------------|
| `operations` | `string[]` | `["read", "write", "edit", "list", "search"]` |
| `prefix` | `string` | Any string (tool name prefix) |
| `trustTier` | `string` | `"sandbox"`, `"verified"`, `"promoted"` |

All fields are optional. Empty/null/undefined options are valid (defaults apply).

### Why the factory throws

`FileSystemBackend` is a runtime interface — it could be backed by local disk, S3, or an in-memory mock. This cannot be constructed from YAML alone. The descriptor participates in **validation and discovery** but delegates construction to `createFileSystemProvider({ backend })`.

```
koi.yaml:
  tools:
    - name: "@koi/filesystem"
      trustTier: "sandbox"

resolve layer:
  1. Find descriptor     → ✓ (kind: "tool", name: "@koi/filesystem")
  2. Validate options    → ✓ (trustTier is valid)
  3. Call factory        → throws: "Use createFileSystemProvider({ backend }) directly"
  4. Runtime must wire   → createFileSystemProvider({ backend: myBackend, trustTier: "sandbox" })
```

---

## Usage

### With Full L1 Runtime

```typescript
import { createFileSystemProvider } from "@koi/filesystem";
import { createKoi } from "@koi/engine";

const provider = createFileSystemProvider({
  backend: myFileSystemBackend,
  trustTier: "verified",
});

const runtime = await createKoi({
  manifest: { name: "code-bot", version: "1.0.0", model: { name: "anthropic:claude-sonnet" } },
  adapter,
  providers: [provider],
});

// Tools are discoverable
runtime.agent.has(toolToken("fs_read"));   // true
runtime.agent.has(toolToken("fs_write"));  // true
```

### Scoped Filesystem (sandboxed)

```typescript
import { createFileSystemProvider } from "@koi/filesystem";

const provider = createFileSystemProvider({
  backend: myBackend,
  scope: {
    root: "/workspace/project",  // restrict to this directory
    readOnly: false,
  },
});
// All paths are resolved relative to root; escapes are blocked
```

### With Semantic Search (Retriever)

```typescript
import { createFileSystemProvider } from "@koi/filesystem";
import { createBm25Retriever } from "@koi/search";          // L2 — local BM25/SQLite
// OR: import { createNexusRetriever } from "@koi/search-nexus";  // L2 — Nexus-backed

const provider = createFileSystemProvider({
  backend: myBackend,
  retriever: createBm25Retriever(/* index config */),
});

// Agent gets all 5 standard tools PLUS fs_semantic_search
runtime.agent.has(toolToken("fs_semantic_search"));  // true
```

The agent can then call `fs_semantic_search` with natural-language queries:
```json
{ "query": "retry logic with exponential backoff", "limit": 5, "minScore": 0.7 }
```

Returns ranked results:
```json
{
  "results": [
    { "id": "1", "score": 0.92, "content": "...", "source": "/src/utils/backoff.ts" },
    { "id": "2", "score": 0.85, "content": "...", "source": "/src/http/retry.ts" }
  ],
  "hasMore": false
}
```

When no retriever is provided, behavior is identical to before — `fs_semantic_search` is not registered.

### Read-Only Subset

```typescript
const provider = createFileSystemProvider({
  backend: myBackend,
  operations: ["read", "list", "search"],  // no write/edit
  prefix: "code",                            // → code_read, code_list, code_search
});
```

### Claude SDK Integration

```typescript
import { CLAUDE_SDK_FILE_TOOLS } from "@koi/filesystem";

// Block Claude SDK's built-in file tools when using Koi filesystem
const adapter = createClaudeAdapter({
  disallowedTools: CLAUDE_SDK_FILE_TOOLS,  // ["Read", "Write", "Edit", "Glob", "Grep"]
});
```

---

## Testing

### Test Structure

```
packages/filesystem/src/
  tools/
    read.test.ts             Read: happy path, options passthrough, validation errors
    write.test.ts            Write: creation, options, validation errors
    edit.test.ts             Edit: single/multi edits, dryRun, validation
    list.test.ts             List: happy path, options, validation errors
    search.test.ts           Search: matches, options, validation errors
    semantic-search.test.ts  Semantic search: retriever delegation, validation, errors
  fs-component-provider.test.ts   Provider: attach, prefix, trust tier, detach, retriever
  descriptor.test.ts              Descriptor: validation, aliases, factory error
```

### Coverage

82 tests total, 0 failures. Includes 11 semantic search tests and 6 retriever integration tests.

```bash
# Run all filesystem tests
bun run test --filter=@koi/filesystem

# Type-check
bun run typecheck --filter=@koi/filesystem
```

---

## Design Decisions

| Decision | Rationale |
|----------|-----------|
| `FileSystemBackend` interface (L0) | Backend is defined in core — any package can provide an implementation (local, S3, mock) |
| ComponentProvider + `createServiceProvider` | Attaches tools via ECS with singleton FILESYSTEM token for middleware access |
| BrickDescriptor with throwing factory | Enables YAML validation and discovery without needing to construct a backend from config |
| Aliases `["filesystem", "fs"]` | Short-hand for `koi.yaml` — `tools: [fs]` resolves to `@koi/filesystem` |
| Scoped filesystem via `@koi/scope` | Optional root containment and read-only mode, composable via config |
| `CLAUDE_SDK_FILE_TOOLS` export | Blocks SDK built-in tools when Koi filesystem replaces them |
| No external dependencies | Everything uses `@koi/core` types; backend implementations are injected |
| Optional `retriever` param | Semantic search only when caller opts in — zero overhead otherwise |
| `Retriever` from `@koi/search-provider` (L0u) | Interface-only dependency; any L2 implementation (BM25, Nexus) plugs in |
| Conditional skill content | Agent guidance adapts: includes `fs_search vs fs_semantic_search` only when retriever present |

---

## Layer Compliance

```
L0  @koi/core ────────────────────────────────────────┐
    Tool, ToolDescriptor, ComponentProvider,            │
    FileSystemBackend, KoiError, Result, TrustTier      │
                                                        │
L0u @koi/scope ───────────────────────────────────────┤
    createScopedFileSystem, FileSystemScope              │
                                                        │
L0u @koi/resolve ─────────────────────────────────────┤
    BrickDescriptor, OptionsValidator                    │
                                                        │
L0u @koi/search-provider ────────────────────────────┤
    Retriever interface                                 │
                                                        │
                                                        ▼
L2  @koi/filesystem ◄──────────────────────────────────┘
    imports from L0 + L0u only
    ✗ never imports @koi/engine (L1)
    ✗ never imports peer L2 packages
    ✗ zero external npm dependencies
    ✓ FileSystemBackend is a plain interface (no vendor types)
    ✓ Retriever is an L0u interface — no search implementation leaks
    ✓ All interface properties readonly
    ✓ Tool execute returns Result-shaped objects (never throws)
    ✓ Engine adapter agnostic (works with loop, Pi, Claude)
```

---

## SkillComponent (skill:filesystem)

`createFileSystemProvider` automatically attaches a `SkillComponent` to the agent under the token `skill:filesystem`. This is pure ECS data — a structured object the middleware stack and orchestrator can read to inject behavioral guidance into the system prompt.

### What the skill teaches

The skill content is generated by `createFsSkill(hasRetriever)` and covers:

| Area | Guidance |
|------|----------|
| **fs_edit vs fs_write** | Use `fs_edit` for targeted changes to existing files; `fs_write` only for new files or full replacements |
| **fs_search vs fs_list** | `fs_search` for content lookup by pattern; `fs_list` for directory structure |
| **fs_search vs fs_semantic_search** | *(only when retriever present)* `fs_search` for exact patterns; `fs_semantic_search` for conceptual queries |
| **Read before edit** | Always `fs_read` first to confirm `oldText` before calling `fs_edit` |
| **Path safety** | Always use absolute paths; never construct paths from untrusted input |

### Accessing the skill

```typescript
import type { SkillComponent } from "@koi/core";
import { skillToken } from "@koi/core";
import { FS_SKILL_NAME } from "@koi/filesystem";

const skill = runtime.agent.component<SkillComponent>(skillToken(FS_SKILL_NAME));
// skill.name     → "filesystem"
// skill.content  → markdown guidance string
// skill.tags     → ["filesystem", "best-practices"]
```

### Using standalone

The `FS_SKILL` constant is exported for use in custom providers:

```typescript
import { FS_SKILL, FS_SKILL_NAME } from "@koi/filesystem";
import { skillToken } from "@koi/core";

customTools: () => [[skillToken(FS_SKILL_NAME) as string, FS_SKILL]],
```
