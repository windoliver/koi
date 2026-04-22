# @koi/middleware-dream

Background dream-consolidation middleware — fires `@koi/dream` consolidation
on `onSessionEnd` when the dream gate is triggered, with safe gate-state
mutation under cross-process concurrency.

## How It Works

The middleware exposes a single `KoiMiddleware` (priority 320) with one
lifecycle hook: `onSessionEnd`.

On every session end:

1. Atomically increment `sessionsSinceDream` in
   `<memoryDir>/.dream-gate.json` via `mutateGateState` (in-process mutex
   chain + cross-process O_EXCL on `.dream-gate.lock` with stale eviction).
2. Check `shouldDream(state)` — by default, fire if both
   `minSessionsSinceLastDream` (default 5) and `minTimeSinceLastDreamMs`
   (default 24 h) are satisfied.
3. If triggered: snapshot a baseline counter, generate a unique lock
   token, and fire `runConsolidationBackground(...)` without `await`.

The background task acquires a process-exclusive lock at
`<memoryDir>/.dream.lock` (PID-bearing, with liveness check to evict
crashed prior holders). On consolidation success it monotonically
subtracts the consumed baseline so any session-end events that fired
during consolidation are preserved (`max(0, current - baseline)`).
On failure it leaves the gate counter intact and releases the lock
in a `finally`.

## Safety

- **Read-modify-write race**: the gate counter is mutated only inside
  `mutateGateState`, which serializes both in-process (per-directory
  Promise chain) and cross-process (file lock with 25 ms retry, 2 s
  total wait, 5 s stale eviction).
- **Lock ownership**: the consolidation lock is `pid:token` and only
  released if both halves match — a process cannot release another
  process's lock.
- **Monotonic gate update**: concurrent session-end events that arrive
  during in-flight consolidation are not erased by the post-success
  reset.
- **Fire-and-forget**: consolidation never blocks the caller; the
  session-end hook returns as soon as the gate state is persisted.

## Configuration

```typescript
import { createDreamMiddleware } from "@koi/middleware-dream";

const mw = createDreamMiddleware({
  memoryDir,                              // .koi/memory directory
  listMemories: () => store.list(),
  writeMemory: async (input) => { await store.write(input); },
  deleteMemory: async (id) => { await store.delete(id); },
  modelCall: adapter.complete,            // ModelHandler — required
  consolidationModel: "openai/gpt-4o",    // optional override
  mergeThreshold: 0.5,                    // optional Jaccard threshold
  pruneThreshold: 0.05,                   // optional salience floor
  minSessionsSinceLastDream: 5,           // optional gate override
  minTimeSinceLastDreamMs: 86_400_000,    // optional gate override
  onDreamComplete: (result) => { ... },   // optional observability
  onDreamError: (err) => { ... },         // optional observability
});
```

In `@koi-agent/cli`, the middleware is wired through the `dreamStack`
preset (`packages/meta/cli/src/preset-stacks/dream.ts`) which reuses the
same `resolveMemoryDir` and `ModelAdapter` as `memoryStack`. The stack
is a no-op when `ctx.modelAdapter` is undefined.

## Priority

320 — after extraction (305) and hot-memory (310).

## Dependencies

- `@koi/core` (L0)
- `@koi/dream` (L0u)
