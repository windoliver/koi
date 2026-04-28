# @koi/scratchpad-local — Local In-Memory Scratchpad

Implements the `ScratchpadComponent` (L0) contract as an in-memory store with CAS
semantics, TTL expiry, glob filtering, and change-event subscriptions.

---

## Why It Exists

Agents in the same process group need a lightweight shared key-value store for
coordination: passing context, tracking intermediate state, and signalling between
turns. The local backend keeps everything in-memory for low latency; the Nexus
backend (separate package) provides persistence across processes.

---

## Public API

```typescript
import { createLocalScratchpad } from "@koi/scratchpad-local";

const sp = createLocalScratchpad({
  groupId: agentGroupId("g1"),
  authorId: agentId("a1"),
});

// Write (unconditional)
sp.write({ path: scratchpadPath("notes/todo.md"), content: "buy milk" });

// Write with CAS — create-only (expectedGeneration = 0)
sp.write({ path: scratchpadPath("lock"), content: "held", expectedGeneration: 0 });

// Write with CAS — update (expectedGeneration = current)
sp.write({ path: scratchpadPath("lock"), content: "held", expectedGeneration: 1 });

// Read
const result = sp.read(scratchpadPath("notes/todo.md"));

// List with glob
const entries = sp.list({ glob: "notes/**" });

// Delete
sp.delete(scratchpadPath("notes/todo.md"));

// Subscribe to changes
const unsub = sp.onChange((event) => console.log(event.kind, event.path));

// Close (stops sweep timer, clears state)
sp.close();
```

---

## CAS Semantics

| `expectedGeneration` | Behavior |
|---------------------|----------|
| `undefined` | Unconditional write (overwrite any version) |
| `0` | Create-only — CONFLICT if path already exists |
| `>0` | CAS update — CONFLICT if current generation ≠ expected; NOT_FOUND if missing |

---

## TTL

Entries with `ttlSeconds` expire at `createdAt + ttlSeconds * 1000` ms.
- **Lazy eviction**: expired entries are treated as absent on every read/list/delete
- **Periodic sweep**: stale entries purged every `sweepIntervalMs` (default 60s) to
  free memory; timer is `unref()`'d so it never blocks process exit

---

## Limits (from `SCRATCHPAD_DEFAULTS`)

| Limit | Value |
|-------|-------|
| Max file size | 1 MiB |
| Max files per group | 1,000 |
| Max path length | 256 chars |

File count is checked after sweeping expired entries to avoid false rejections.

---

## Glob Filtering

`list({ glob })` uses `Bun.Glob` for pattern matching against entry paths.
- `*` — matches any characters except `/`
- `**` — matches any characters including `/`
- Omitting `glob` returns all entries

---

## Layer & Dependencies

- **Layer**: L2
- **Imports from**: `@koi/core` (L0) only
- **No filesystem I/O** — purely in-memory

---

## Changelog

- 2026-04-24 — Initial v2 implementation (issue #1370)
