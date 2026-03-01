# createKoi Async Generator Architecture

Decomposition of the `createKoi()` run loop from a manual `AsyncIterator` into
an `async function*` generator — consolidating cleanup, improving readability,
and reducing the inner function from 288 lines to focused sub-50-line sections.

**Layer**: L1 (`@koi/engine`)
**Issue**: #626

---

## Why It Exists

The original `createKoi().run()` returned a hand-rolled `AsyncIterator` with
explicit `next()` and `return()` methods. This had several problems:

```
             Before (manual iterator)          After (async generator)
             ──────────────────────            ─────────────────────
Cleanup:     6 duplicated sites                1 finally block
next():      288 lines, 7+ nesting levels      yield statements in linear flow
return():    separate method, races with next   generator.return() handled natively
Error paths: easy to miss cleanup              try/catch/finally guarantees it
Readability: state machine with flags          sequential top-to-bottom flow
```

---

## Architecture

### Generator lifecycle

```
run(input)
  │
  └─► { [Symbol.asyncIterator]: () => streamEvents(input) }
         │
         ▼
  ┌──────────────────────────────────────┐
  │  async function* streamEvents()      │
  │                                      │
  │  try {                               │
  │    // Session initialization         │
  │    //   - agent → running            │
  │    //   - onSessionStart hooks       │
  │    //   - forge subscription         │
  │    //   - tool terminal wiring       │
  │                                      │
  │    while (!done) {                   │
  │      // Deferred forge refresh       │
  │      // Turn start                   │
  │      yield { kind: "turn_start" }    │
  │                                      │
  │      // Adapter event loop           │
  │      for await (event of adapter) {  │
  │        yield event                   │
  │        if (done) break               │
  │      }                               │
  │    }                                 │
  │                                      │
  │  } catch (error) {                   │
  │    // Error recovery → done event    │
  │                                      │
  │  } finally {                         │
  │    // Single cleanup site:           │
  │    //   - running = false            │
  │    //   - forge unsubscribe          │
  │    //   - abort listener removal     │
  │    //   - agent → terminated         │
  │    //   - onSessionEnd hooks         │
  │  }                                   │
  └──────────────────────────────────────┘
```

### Cleanup consolidation

The `finally` block runs regardless of how the generator exits:

| Exit path | Trigger | finally runs? |
|-----------|---------|---------------|
| Normal completion | `done` event from adapter | Yes |
| Consumer break | `for await` loop exits early | Yes |
| Consumer `.return()` | Explicit iterator return | Yes |
| Abort signal | `AbortSignal` fires | Yes |
| Unhandled error | Throw propagates out | Yes |

This replaces 6 separate cleanup sites in the original code with one
authoritative location.

### Tool descriptor deduplication

Tool descriptors come from two sources: the agent's entity descriptors (static)
and forge-provided descriptors (dynamic, updated via subscription). These are
merged with forge taking precedence on name collisions.

```
┌─────────────────────┐    ┌──────────────────────┐
│ Entity descriptors  │    │ Forge descriptors    │
│ (from manifest)     │    │ (from subscription)  │
└─────────┬───────────┘    └──────────┬───────────┘
          │                           │
          ▼                           ▼
  ┌──────────────────────────────────────────┐
  │ createDedupedToolsAccessor()             │
  │                                          │
  │  get():  [...forge, ...entity ∖ forge]   │
  │  updateForged(): invalidate memo         │
  │                                          │
  │  Memoized: same forge ref → same output  │
  └──────────────────────────────────────────┘
```

The accessor uses ref-equality on the forged array to skip recomputation.
When forge descriptors haven't changed, `get()` returns the same array
reference — zero allocation per access.

---

## Key files

| File | Role |
|------|------|
| `packages/engine/src/koi.ts` | Main runtime — `createKoi()` + `streamEvents()` generator |
| `packages/engine/src/deduped-tools-accessor.ts` | Memoized tool descriptor merge |
| `packages/engine/src/deduped-tools-accessor.test.ts` | Unit tests for dedup accessor |
| `packages/engine/src/koi.test.ts` | 92 tests including 5 error path tests |

---

## Error path coverage

Five dedicated tests cover error recovery in the generator:

| Test | Scenario | Verified behavior |
|------|----------|-------------------|
| Hook throw (session start) | `onSessionStart` throws | Error propagates, agent terminates |
| Hook throw (before turn) | `onBeforeTurn` throws | `KoiRuntimeError` → done event |
| Forge refresh failure | `forge.toolDescriptors()` throws | Error propagates at turn boundary |
| Abort during init | Signal aborted during `onSessionStart` | Clean shutdown, `onSessionEnd` called |
| Concurrent abort + return | Signal + `.return()` simultaneously | Single cleanup, no double-dispose |
