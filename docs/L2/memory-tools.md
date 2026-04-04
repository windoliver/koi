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
| `memory_store` | name, description, type, content | force | Dedup check by name+type; `force: true` overwrites |
| `memory_recall` | query | limit, tier, graph_expand, max_hops | Ranked retrieval with tier filter and causal graph expansion |
| `memory_search` | (all optional) | keyword, type, updated_after, updated_before, limit | Keyword, type, and strict ISO 8601 date range filtering |
| `memory_delete` | id | — | Existence check then delete |

## Architecture

### MemoryToolBackend (DI interface)

Tools depend on a `MemoryToolBackend` interface — the DI seam between tool surfaces
and the backing store. Methods return `T | Promise<T>` so sync implementations
(in-memory for tests) and async implementations (filesystem for production) use the
same interface.

Backend methods: `store`, `recall`, `search`, `delete`, `findByName`, `get`, `update`.

### Error handling

- Expected failures (validation, not-found): returned as `{ error, code: "VALIDATION" }` objects
- Backend failures: sanitized via `safe-error.ts` — raw paths and OS error text are never exposed to the model
- Unexpected exceptions: caught and mapped to generic `{ error: "Failed to ...", code: "INTERNAL" }`

### Input validation

- `parseOptionalInteger` for limit/max_hops fields — rejects fractional numbers
- Strict ISO 8601 regex + calendar roundtrip check for timestamps
- Name/description canonicalized (control chars stripped, whitespace collapsed) before dedup lookup
- Constructor-time validation of recallLimit/searchLimit (must be positive integers)

### Skill content

`generateMemoryToolSkillContent()` produces LLM prompt instructions with configurable
tool prefix and optional baseDir (sanitized against prompt injection).

## Provider

`createMemoryToolProvider(config)` builds all 4 tools and returns a `ComponentProvider`
for agent assembly. Accepts configurable prefix, recall/search limits, and priority.

## Key files

| File | Purpose |
|------|---------|
| `src/types.ts` | `MemoryToolBackend` interface, config types |
| `src/tools/memory-store.ts` | Store with dedup check and canonicalization |
| `src/tools/memory-recall.ts` | Recall with limit clamping and materialized defaults |
| `src/tools/memory-search.ts` | Search with keyword normalization and date validation |
| `src/tools/memory-delete.ts` | Delete with existence check |
| `src/safe-error.ts` | Sanitized error responses |
| `src/parse-args.ts` | Argument parsing with integer/timestamp validation |
| `src/skill.ts` | Prefix-aware prompt instructions |
| `src/provider.ts` | ComponentProvider factory |
