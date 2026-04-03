# @koi/memory

Persistent memory system for Koi agents — file-per-memory with key-value frontmatter.

## Domain Model

### Memory Record

A `MemoryRecord` is a single persisted fact stored as a Markdown file with
key-value frontmatter (a bespoke format, **not standard YAML**):

```markdown
---
name: {{memory name}}
description: {{one-line description — used for relevance matching}}
type: user | feedback | project | reference
---

{{content body — structured per type guidelines}}
```

The frontmatter format uses `key: value` lines delimited by `---`. It does
**not** support YAML features like comments (`#`), quoting, multi-line
scalars, anchors, or flow syntax. Values are treated as raw strings after
the first colon.

**Fields:**

| Field | Type | Description |
|-------|------|-------------|
| `id` | `MemoryRecordId` | Branded unique identifier |
| `name` | `string` | Human-readable name |
| `description` | `string` | One-line summary for relevance matching |
| `type` | `MemoryType` | Category: `user`, `feedback`, `project`, `reference` |
| `content` | `string` | The memory body (Markdown) |
| `filePath` | `string` | Path to the `.md` file (relative, POSIX, no percent-encoding) |
| `createdAt` | `number` | Unix timestamp of creation |
| `updatedAt` | `number` | Unix timestamp of last update |

### Memory Types

| Type | Purpose | Body Structure |
|------|---------|----------------|
| `user` | Role, preferences, expertise | Free-form description of user |
| `feedback` | Corrections and validated approaches | Rule, then **Why:** and **How to apply:** |
| `project` | Ongoing work context, deadlines | Fact/decision, then **Why:** and **How to apply:** |
| `reference` | Pointers to external systems | Resource location and purpose |

### Memory Index (MEMORY.md)

The `MemoryIndex` models the `MEMORY.md` file — an always-loaded index of all memories.

- Each entry is one line: `- [Title](file.md) — one-line hook`
- Maximum 200 lines (truncated after that)
- Not a memory itself — purely an index of pointers

### Lifecycle

```
create → read/update → (optional) delete
```

No state machine — records are either present or deleted. Updates replace content in-place.

### Validation

- All frontmatter fields (`name`, `description`, `type`) are required
- Fields are validated after sanitization (control chars stripped, newlines collapsed)
- `type` must be one of the 4 valid `MemoryType` values (validated at runtime)
- `content` must be non-empty (enforced in both parser and serializer)
- Frontmatter parsing rejects malformed delimiters, duplicate keys, unknown keys
- File paths must be relative, `.md` extension, no `..` traversal, no percent-encoding

## L0 Types

All types are in `@koi/core` (`packages/kernel/core/src/memory.ts`):

- `MemoryRecordId` — branded string
- `MemoryType` — `"user" | "feedback" | "project" | "reference"`
- `MemoryRecord` — full state
- `MemoryRecordInput` — creation input
- `MemoryRecordPatch` — sparse update
- `MemoryFrontmatter` — frontmatter fields (bespoke key: value format, not YAML)
- `MemoryIndex` / `MemoryIndexEntry` — index model

### Pure Functions

- `isMemoryType()` — type guard
- `parseMemoryFrontmatter()` — parse frontmatter from raw Markdown
- `serializeMemoryFrontmatter()` — serialize frontmatter + content to Markdown
- `validateMemoryRecordInput()` — validate input fields (post-sanitization)
- `validateMemoryFilePath()` — validate file path safety
- `formatMemoryIndexEntry()` / `parseMemoryIndexEntry()` — index line formatting
- `hasFrontmatterUnsafeChars()` — detect unsafe characters in field values
