# Design: Atomic (name, type) Upsert in MemoryStore

**Issue:** [#1824](https://github.com/windoliver/koi/issues/1824)
**Date:** 2026-04-15
**Status:** Approved

## Problem

`storeWithDedup` in the memory adapter does check-then-act (`list()` → `find()` → `write()`/`update()`) that is not atomic across processes. Two concurrent `koi` processes sharing the same memory directory can both observe "no match" and both create records with the same `(name, type)`, leaving duplicates on disk.

The in-process `dedupChain` mutex (added in #1815) handles single-agent concurrency but not cross-process races.

## Decision: Unified Atomic `upsert()`

Add `upsert(input, opts)` to `MemoryStore` that runs name+type lookup AND Jaccard content dedup AND create/update inside the same `withDirLock()` critical section.

### Why unified (not name+type only)

- Both checks need `scanRecords()` — one scan serves both.
- Eliminates semantic gap where name+type says "new" but Jaccard says "duplicate."
- Lock cost is already paid; Jaccard adds negligible CPU (in-memory set intersection).
- Adapter collapses to a single `store.upsert()` call.

### `force: true` skips both checks

When force is set, a name+type match triggers an immediate update. No Jaccard check runs. This preserves current adapter behavior where the agent explicitly chose to overwrite.

## `UpsertResult` Type

Defined in `packages/mm/memory-fs/src/types.ts` (L2 — no cross-L2 import):

```typescript
type UpsertResult =
  | { readonly action: "created"; readonly record: MemoryRecord; readonly indexError?: unknown }
  | { readonly action: "updated"; readonly record: MemoryRecord; readonly indexError?: unknown }
  | { readonly action: "conflict"; readonly existing: MemoryRecord; readonly indexError?: unknown }
  | { readonly action: "skipped"; readonly record: MemoryRecord; readonly duplicateOf: MemoryRecordId; readonly similarity: number; readonly indexError?: unknown };
```

| Variant | When |
|---------|------|
| `created` | No name+type match, no Jaccard match, new file written |
| `updated` | Name+type match found, `force: true`, record overwritten |
| `conflict` | Name+type match found, `force: false`, returned as-is |
| `skipped` | No name+type match, Jaccard caught content similarity |

## `upsert()` Method

Added to `MemoryStore` interface:

```typescript
interface MemoryStore {
  // ... existing methods ...
  readonly upsert: (
    input: MemoryRecordInput,
    opts: { readonly force: boolean },
  ) => Promise<UpsertResult>;
}
```

### Internal flow (inside `withDirLock()`)

```
1. scanRecords(dir)           — one disk scan
2. find by (name, type)       — exact match in scanned list
   ├─ found + force=false     → return { action: "conflict", existing }
   ├─ found + force=true      → updateRecord(existing, patch) → { action: "updated" }
   └─ not found               → continue
3. findDuplicate(content, scanned, threshold)  — Jaccard
   ├─ duplicate found         → return { action: "skipped", duplicateOf, similarity }
   └─ no duplicate            → continue
4. writeExclusive(dir, name, serialized) → return { action: "created" }
```

Index rebuild enqueued outside the lock (same as existing `write()` and `update()`).

## Adapter Simplification

`packages/meta/cli/src/preset-stacks/memory-adapter.ts` changes:

**Remove:**
- `dedupChain` promise chain
- `withDedupLock()` helper
- The `list()` → `find()` → `write()`/`update()` sequence

**Replace with:**
```typescript
storeWithDedup: async (input, opts) => {
  try {
    const result = await store.upsert(input, { force: opts.force });
    return ok(mapUpsertResult(result));
  } catch (e: unknown) {
    return fail(e);
  }
}
```

`mapUpsertResult` maps the four `UpsertResult` variants to three `StoreWithDedupResult` variants:
- `created` → `created`
- `updated` → `updated`
- `conflict` → `conflict`
- `skipped` → `conflict` (Jaccard dedup surfaces as conflict to the adapter)

## Multi-Process Concurrency Test

**File:** `packages/mm/memory-fs/src/cross-process.test.ts`

**Strategy:** Parent spawns a real child process via `Bun.spawn` that races against the parent. Both call `upsert()` on the same `(name, type)`. A shared "go" signal file coordinates the start.

**Test cases:**

1. **Two writers, same (name, type), force: false** — exactly one `created`, one `conflict`. One file on disk.
2. **Two writers, same (name, type), force: true** — both succeed, exactly one file on disk (last writer wins).
3. **Two writers, different (name, type)** — both `created`, two files on disk.

**Worker script:** `packages/mm/memory-fs/src/__tests__/cross-process-worker.ts` — imports `createMemoryStore`, reads config from argv/env, calls `upsert()`, writes result JSON to stdout.

## Files Changed

| File | Change |
|------|--------|
| `packages/mm/memory-fs/src/types.ts` | Add `UpsertResult`, add `upsert` to `MemoryStore` |
| `packages/mm/memory-fs/src/store.ts` | Implement `upsert` inside `withDirLock()` |
| `packages/mm/memory-fs/src/cross-process.test.ts` | Multi-process concurrency tests (3 cases) |
| `packages/mm/memory-fs/src/__tests__/cross-process-worker.ts` | Child process worker script |
| `packages/mm/memory-fs/src/store.test.ts` | Unit tests for `upsert()` — all 4 result variants |
| `packages/meta/cli/src/preset-stacks/memory-adapter.ts` | Remove `dedupChain`, delegate to `store.upsert()` |
| `packages/meta/cli/src/preset-stacks/memory-adapter.test.ts` | Update tests for simplified adapter |

**Not changed:**
- `@koi/core` (L0) — `MemoryRecordInput` already exists
- `lock.ts` — locking mechanism unchanged
- `dedup.ts` — Jaccard logic unchanged, called from new site
- Existing `write()` — preserved as-is

## Existing Method Preservation

`write()` stays on `MemoryStore`. It provides Jaccard-only dedup for callers that don't need name+type matching. `upsert()` is additive — no breaking changes.
