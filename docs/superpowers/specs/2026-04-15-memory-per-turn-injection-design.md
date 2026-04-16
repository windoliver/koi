# Design: Per-Turn Memory Re-Injection (Live Delta)

**Issue:** [#1829](https://github.com/windoliver/koi/issues/1829)
**Date:** 2026-04-15
**Status:** Approved

## Problem

Memories stored mid-session are invisible to the agent until the next session (or an explicit `memory_recall` tool call). Other frameworks (Hermes Agent, OpenCode) re-inject memory every turn so new memories appear automatically.

## Prior Art

| Framework | Strategy | Cache-friendly? |
|-----------|----------|-----------------|
| **Claude Code** | Load once at session start | Yes (frozen) |
| **Hermes Agent** | Full memory rebuild per turn, separate from cached system prompt | Yes (instructions cached, memory always live) |
| **OpenCode** | Re-read files per turn, rebuild system prompt | No (invalidates prefix) |

## Decision: Frozen Snapshot + Live Delta

Keep the frozen snapshot as part of the prefix-cached prefix. Add a live delta block after conversation history for new/changed memories. This gives both prefix caching AND mid-session freshness — better than Hermes (where all memory is uncached) and better than OpenCode (which invalidates the prefix).

### Message Ordering (prefix cache optimal)

```
1. System prompt                              ← cached prefix
2. Frozen memory snapshot (system:memory-recall)  ← cached prefix
3. Conversation turns 1..N-1                  ← cached prefix
4. Live memory delta (system:memory-live)     ← not cached, only when mtime changed
5. Relevance overlay (system:memory-relevant) ← not cached, only when frozen truncated
6. Current user message                       ← new
```

Positions 1-3 form the stable prefix — never invalidated by memory changes. Positions 4-5 are appended after conversation history so they never break the cache.

**Typical turn (no mid-session memory change):** positions 4 and 5 are absent. Zero extra cost.

**After mid-session memory store:** position 4 appears with the new memory. One `stat()` + dir scan.

**Heavy memory user (50+ memories, frozen truncated):** position 5 appears with model-ranked overflow memories. Existing behavior, unchanged.

## Change Detection: `mtime` Guard

Per turn, inside `wrapModelCall`:

1. `stat(memoryDir)` — one syscall, ~0.1ms
2. Compare `dirStat.mtimeMs` against `state.lastDirMtime`
3. If unchanged: skip scan, reuse previous delta (or none)
4. If changed:
   - `scanMemoryDirectory()` — reads all `.md` files
   - Diff against `state.frozenPaths` — filter to new/changed files only
   - Format via `formatMemorySection()` (same trusted formatter as frozen snapshot)
   - Cache as `state.liveMessage` — reused until next `mtime` change
   - Update manifest (so relevance selector sees new memories)

**Limitation:** NFS can have stale `mtime`. Consistent with existing `withDirLock` which already declares NFS unsupported.

**Deleted memories mid-session:** frozen snapshot may reference deleted files. Acceptable — frozen block is prefix-cached and immutable. Model sees stale data for deletions until next session. Stores and updates are the critical path.

## Middleware State Changes

`SessionRecallState` gains three fields:

```typescript
interface SessionRecallState {
  // ... existing fields ...
  lastDirMtime: number;                     // mtime after frozen scan
  liveMessage: InboundMessage | undefined;  // cached delta block
  livePaths: ReadonlySet<string>;           // paths in delta (for exclusion)
}
```

Initialized at session start:
- `lastDirMtime` = dir mtime after frozen scan (avoids immediate re-scan)
- `liveMessage` = undefined
- `livePaths` = empty set

## Relevance Selector Update

Candidate filter updated to exclude both frozen AND live delta paths:

```typescript
// Before: exclude frozen only
const candidates = manifest.filter(m => !state.frozenPaths.has(m.filePath));

// After: exclude frozen AND live delta
const candidates = manifest.filter(
  m => !state.frozenPaths.has(m.filePath) && !state.livePaths.has(m.filePath),
);
```

Prevents triple-injection (same memory in frozen + delta + relevance). Manifest updated when live delta detects new files, so relevance selector can rank new memories alongside overflow.

## Injection Flow in `wrapModelCall`

```typescript
// 1. Frozen snapshot — prepend (unchanged, prefix-stable)
let effectiveRequest = injectFrozenSnapshot(state, request);

// 2. Live delta — check mtime, scan if changed, append after conversation
await refreshLiveDelta(state, config);
if (state.liveMessage !== undefined) {
  effectiveRequest = {
    ...effectiveRequest,
    messages: [...effectiveRequest.messages, state.liveMessage],
  };
}

// 3. Relevance overlay — append after delta (unchanged logic, updated candidates)
if (config.relevanceSelector !== undefined) {
  const relevantMsg = await selectRelevant(state, request);
  // ...append if present...
}

return next(effectiveRequest);
```

Same logic in both `wrapModelCall` and `wrapModelStream`.

## Files Changed

| File | Change |
|------|--------|
| `packages/mm/middleware-memory-recall/src/memory-recall-middleware.ts` | Add `refreshLiveDelta()`, new state fields, update injection ordering, update relevance candidate filter |
| `packages/mm/middleware-memory-recall/src/memory-recall-middleware.test.ts` | Tests: delta appears after store, mtime guard skips re-scan, delta excluded from relevance candidates |
| `packages/mm/middleware-memory-recall/src/types.ts` | Add `memoryDir: string` to config |
| `packages/meta/cli/src/preset-stacks/memory.ts` | Pass `memoryDir` to middleware config |

**Not changed:**
- `@koi/memory` — `scanMemoryDirectory` and `formatMemorySection` already exported
- `@koi/memory-fs` — no changes
- Frozen snapshot logic — untouched
- Relevance selector logic — unchanged except candidate filter

**Scope:** ~80 lines new code in middleware, ~150 lines tests.
