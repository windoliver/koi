# @koi/memory-tools

Memory tool surfaces for LLM agent execution — store, recall, search, delete.

## Layer

L2 — depends on `@koi/core` (L0), `@koi/tools-core` (L0u).

## Purpose

Provides 4 memory tools that the LLM calls to interact with the memory system
during agent execution. Unlike Claude Code (which relies on generic Read/Write/Edit
tools), Koi provides dedicated memory tools for structured inputs, server-side
dedup/validation, event emission, and consistent frontmatter formatting.

## Tools

| Tool | Required Inputs | Optional Inputs | Behavior |
|------|----------------|-----------------|----------|
| `memory_store` | name, description, type, content | force | Atomic dedup by name+type via `storeWithDedup`; exact-payload retry returns `replayed: true`; `force: true` overwrites |
| `memory_recall` | query | limit, tier, graph_expand, max_hops | Ranked retrieval with tier filter and causal graph expansion |
| `memory_search` | (all optional) | keyword, type, updated_after, updated_before, limit | Keyword, type, and strict ISO 8601 date range filtering |
| `memory_delete` | id | — | Idempotent delete — `deleted: true` always; `wasPresent` distinguishes removal from no-op |

## Sandbox boundary

All 4 tools run sandboxed (`sandbox: true`) with explicit filesystem capabilities
scoped to a configured `memoryDir`:

- **Write tools** (store, delete): `filesystem: { read: [memoryDir], write: [memoryDir] }`
- **Read tools** (recall, search): `filesystem: { read: [memoryDir] }`

`memoryDir` is validated by `validateMemoryDir()` — must be absolute, no `..`
traversal, minimum 2 path segments (rejects `/`, `/tmp`, etc.). Validation runs
in both the provider and each individual tool constructor to prevent bypass.

**Known limitation:** `buildTool()` unions caller paths with `DEFAULT_SANDBOXED_POLICY`
defaults (read: `/usr`,`/bin`,`/lib`,`/etc`,`/tmp`; write: `/tmp/koi-sandbox-*`).
A future `buildTool` "replace" mode will restrict to `memoryDir` only.

## Architecture

### MemoryToolBackend (DI interface)

Tools depend on a `MemoryToolBackend` interface — the DI seam between tool surfaces
and the backing store. Methods return `T | Promise<T>` so sync implementations
(in-memory for tests) and async implementations (filesystem for production) use the
same interface.

Backend methods: `store`, `storeWithDedup`, `recall`, `search`, `delete`,
`findByName`, `get`, `update`.

### Atomic store (storeWithDedup)

`memory_store` delegates to `backend.storeWithDedup(input, { force })` — a single
atomic call that returns a discriminated union:

| `force` | Match by `(name, type)` | Result |
|---------|------------------------|--------|
| `false` | exists, same payload | `stored: true, replayed: true` (retry-safe) |
| `false` | exists, different payload | `stored: false, duplicate: { id, name }` |
| `false` | no match | `stored: true, id` |
| `true` | exists | `stored: true, updated: true` |
| `true` | no match | `stored: true, id` |
| any | legacy corruption (2+ records share canonical key) | `stored: false, corrupted: { canonicalName, conflictingIds }` |

No check-then-act race — uniqueness is enforced by the backend atomically.

### Legacy corruption handling

When the backend encounters multiple records sharing the same canonical
`(name, type)` — a state that could arise from the pre-atomic
`list→find→write` race on older code paths — `storeWithDedup` returns
`action: "corrupted"` with the conflicting record IDs. The `memory_store`
tool surfaces actionable remediation: delete all conflicting IDs via
`memory_delete` and retry, or delete all but one and retry with
`force: true` to overwrite the survivor.

### Idempotent delete

`memory_delete` calls `backend.delete(id)` directly (no get precheck). The backend
returns `{ wasPresent: boolean }`. The tool always returns `deleted: true` —
the desired state (record absent) is achieved regardless. `wasPresent` is
informational metadata for callers that need to distinguish.

### Error handling

- Expected failures (validation, not-found): returned as `{ error, code: "VALIDATION" }` objects
- Backend failures: sanitized via `safe-error.ts` — raw paths and OS error text are never exposed to the model
- Unexpected exceptions: caught and mapped to generic `{ error: "Failed to ...", code: "INTERNAL" }`

### Input validation

- `parseOptionalInteger` for limit/max_hops fields — rejects fractional numbers
- Strict ISO 8601 regex + calendar roundtrip check for timestamps
- Name/description canonicalized (control chars stripped, whitespace collapsed) before dedup lookup
- Constructor-time validation of recallLimit/searchLimit (must be positive integers)
- `validateMemoryDir()` for sandbox boundary (absolute path, no traversal, min depth)

### Skill content

`generateMemoryToolSkillContent()` produces LLM prompt instructions with configurable
tool prefix and optional baseDir (sanitized against prompt injection).

## Provider

`createMemoryToolProvider(config)` builds all 4 tools and returns a `ComponentProvider`
for agent assembly. Requires `memoryDir` (absolute path to memory storage directory).
Accepts configurable prefix, recall/search limits, and priority.

### SkillComponent

The provider attaches a `SkillComponent` (name: `"memory"`) with behavioral guidance
generated by `generateMemoryToolSkillContent()`. This tells the LLM:

- Memories are **auto-injected** at session start — no need to call `memory_recall`
- When to use `memory_store` (preferences, corrections, decisions)
- When NOT to store (greetings, derivable info, duplicates)
- Memory types and decay tiers

Follows the `BROWSER_SKILL` ECS pattern from `@koi/tool-browser`.

## Key files

| File | Purpose |
|------|---------|
| `src/types.ts` | `MemoryToolBackend` interface, `StoreWithDedupResult`, `DeleteResult`, config types |
| `src/constants.ts` | Defaults + `validateMemoryDir()` shared helper |
| `src/tools/memory-store.ts` | Atomic store via `storeWithDedup` with retry-safe exact-payload reconciliation |
| `src/tools/memory-recall.ts` | Recall with limit clamping and materialized defaults |
| `src/tools/memory-search.ts` | Search with keyword normalization and date validation |
| `src/tools/memory-delete.ts` | Idempotent delete returning `wasPresent` metadata |
| `src/safe-error.ts` | Sanitized error responses |
| `src/parse-args.ts` | Argument parsing with integer/timestamp validation |
| `src/skill.ts` | Prefix-aware prompt instructions |
| `src/provider.ts` | ComponentProvider factory with `memoryDir` validation |
