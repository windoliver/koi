# Issue 2204: Nexus Memory Backend Design

## Context

Issue #2204 moves Koi's memory storage surface onto the Nexus context plane. It follows #2203, which established Nexus-backed session state, and it stays inside the #1320 context-plane scope: session state, memory, artifacts, and shared context are persistent files under stable Nexus namespaces.

Koi already has two useful pieces:

- `@koi/memory-fs` owns the `MemoryStore` contract and the markdown/frontmatter compatibility format used by memory tools.
- `@koi/fs-nexus` implements `FileSystemBackend` over Nexus and exposes `semanticSearch()` for nexus-ai-fs hybrid retrieval.

## Boundary With Cairn

Per #2044, Cairn owns memory reasoning: ranking, consolidation, profiles, dream/evolution workflows, retrieval policy, and long-term memory semantics. This issue does not add those behaviors to Koi.

Koi remains responsible for harness storage integration. The Koi-owned work is limited to writing, reading, listing, updating, deleting, and indexing the existing markdown memory records through a selected storage backend. When the selected backend is Nexus, records live under the Nexus `/memory/` namespace and become visible to Nexus semantic indexing as ordinary markdown files.

## Architecture

Add a new `FileSystemBackend`-backed adapter inside `@koi/memory-fs`:

```ts
createFileSystemMemoryStore({
  fs,
  memoryDir: "/memory",
  dedupThreshold,
  onIndexError,
})
```

The existing local `createMemoryStore({ dir })` remains unchanged and remains the local/default storage implementation. The new adapter implements the same `MemoryStore` interface, so callers can select local storage or Nexus storage without changing memory tool behavior.

The adapter uses the existing L0 memory model:

- `serializeMemoryFrontmatter()` for writes and updates.
- `parseMemoryFrontmatter()` for reads and scans.
- `validateMemoryRecordInput()` for pre-side-effect validation.
- `sanitizeFrontmatterValue()` for canonical `(name, type)` comparisons.
- `deriveFilename()` and `slugifyMemoryName()` for compatible markdown filenames.

The adapter treats malformed memory files as skipped during `list()` and `read()`, matching the fail-closed scan behavior in `@koi/memory`. This preserves trust boundaries: unknown future frontmatter, blank confidence, missing content, or malformed records do not surface as trusted memories.

## Data Flow

Writes:

1. Validate input before backend writes.
2. List valid memory records under `memoryDir`.
3. Reject same `(canonical name, type)` conflicts unless using `upsert(..., { force: true })`.
4. Apply existing Jaccard deduplication.
5. Write serialized markdown to `${memoryDir}/${derivedFilename}`.
6. Rebuild `MEMORY.md` best-effort from valid records.

Reads and lists:

1. List `${memoryDir}` recursively for `*.md`.
2. Ignore `MEMORY.md`.
3. Read and parse each record.
4. Skip malformed records.
5. Return records sorted newest first where backend modification metadata exists.

Updates:

1. Resolve the target record by id.
2. Preserve unpatched fields.
3. Reject renames onto an existing `(canonical name, type)`.
4. Rewrite the same markdown file.
5. Rebuild `MEMORY.md` best-effort.

Deletes:

1. Resolve the target record by id.
2. Use backend `delete()` when available.
3. Treat missing records as `{ deleted: false }`.
4. Rebuild `MEMORY.md` after successful deletion.

## Semantic Search

The adapter does not implement a new memory search or ranking layer. Nexus-backed records are ordinary markdown files under `/memory/`; nexus-ai-fs discovers them through its existing indexing pipeline. Consumers that need meaning-based discovery should use the selected Nexus filesystem backend's `semanticSearch()` with `scope: "memory/**"` or an equivalent path-scoped query.

This keeps Koi in the storage role and avoids duplicating Cairn-owned retrieval logic.

## Error Handling

Backend `Result` errors are converted to thrown `Error`s at the `MemoryStore` boundary because the existing `MemoryStore` interface is exception-based. Mutation results keep the existing `indexError` field for best-effort `MEMORY.md` rebuild failures.

Malformed records are skipped during scans rather than thrown, so one corrupt file cannot starve cross-session recall. Listing failures still throw because the store cannot establish the namespace state.

## Tests

Add focused tests in `@koi/memory-fs` using a small in-memory `FileSystemBackend` fixture:

- write, read, list, update, delete, and `MEMORY.md` rebuild through the backend adapter.
- malformed markdown files are skipped while valid records remain available.
- two store instances sharing the same backend and `/memory/` namespace observe cross-session persistence.
- semantic-search discoverability is represented by a backend with `semanticSearch()` that sees the markdown files written under `/memory/`.
- local `createMemoryStore()` tests remain unchanged and passing.

## Public API

Export the new adapter and config types from `@koi/memory-fs` using ESM `.js` imports internally:

- `createFileSystemMemoryStore`
- `FileSystemMemoryStoreConfig`

No new package dependency on `@koi/fs-nexus` is required; the adapter accepts the L0 `FileSystemBackend` contract.

`@koi/runtime` exposes this path through `RuntimeConfig.memoryBackend`, which accepts the same
`FileSystemMemoryStoreConfig` and is mutually exclusive with the existing local `memoryFs` config.
