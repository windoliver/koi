# @koi/memory

Persistent memory system for Koi agents — file-per-memory with YAML frontmatter.

## Domain Model

### Memory Record

A `MemoryRecord` is a single persisted fact stored as a Markdown file with YAML frontmatter:

```markdown
---
name: {{memory name}}
description: {{one-line description — used for relevance matching}}
type: user | feedback | project | reference
---

{{content body — structured per type guidelines}}
```

**Fields:**

| Field | Type | Description |
|-------|------|-------------|
| `id` | `MemoryRecordId` | Branded unique identifier |
| `name` | `string` | Human-readable name |
| `description` | `string` | One-line summary for relevance matching |
| `type` | `MemoryType` | Category: `user`, `feedback`, `project`, `reference` |
| `content` | `string` | The memory body (Markdown) |
| `filePath` | `string` | Path to the `.md` file |
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
- `type` must be one of the 4 valid `MemoryType` values
- `content` must be non-empty
- Frontmatter parsing rejects malformed YAML delimiters

## L0 Types

All types are in `@koi/core` (`packages/kernel/core/src/memory.ts`):

- `MemoryRecordId` — branded string
- `MemoryType` — `"user" | "feedback" | "project" | "reference"`
- `MemoryRecord` — full state
- `MemoryRecordInput` — creation input
- `MemoryRecordPatch` — sparse update
- `MemoryFrontmatter` — YAML frontmatter fields
- `MemoryIndex` / `MemoryIndexEntry` — index model

### Pure Functions

- `isMemoryType()` — type guard
- `parseMemoryFrontmatter()` — parse YAML frontmatter from raw Markdown
- `serializeMemoryFrontmatter()` — serialize frontmatter + content to Markdown
- `validateMemoryRecordInput()` — validate input fields
- `formatMemoryIndexEntry()` / `parseMemoryIndexEntry()` — index line formatting
