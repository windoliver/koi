# Global Concurrency Guard

Counting-semaphore middleware that caps concurrent model/tool calls across all
agents sharing a single guard instance. Prevents rate-limit hits, memory spikes,
and starvation when many agents run simultaneously.

**Layer**: L1 (`@koi/engine`)
**Issue**: #161

---

## Why It Exists

Koi's `SpawnGuard` limits tree depth and fan-out (structural shape), but does
not limit how many model or tool calls are in flight at any given moment. When
ten agents each fire a model call simultaneously, the system sends ten parallel
API requests — hitting rate limits, consuming memory for ten response buffers,
and starving lower-priority agents.

```
                Before                              After
                ──────                              ─────
10 agents call: 10 parallel API requests            max 5 in flight, 5 queued
Rate limits:    hit frequently                      smoothed by semaphore
Memory:         10 response buffers at once          max 5 at once
Fairness:       first-come-first-served race        FIFO queue, deterministic
```

---

## Architecture

### Two semaphores, one middleware

```
createConcurrencyGuard({ maxConcurrentModelCalls: 5, maxConcurrentToolCalls: 10 })
       │
       ├─ modelSemaphore (capacity: 5)
       │     │
       │     ├─ wrapModelCall   → acquire slot → next(req) → release
       │     └─ wrapModelStream → acquire slot → iterate stream → release
       │
       └─ toolSemaphore (capacity: 10)
             │
             └─ wrapToolCall    → acquire slot → next(req) → release
```

Model calls and tool calls are gated independently — a burst of tool calls
does not block model calls, and vice versa.

### Shared across sessions

```
const guard = createConcurrencyGuard({ maxConcurrentModelCalls: 5 });

const agent1 = await createKoi({ middleware: [guard] });
const agent2 = await createKoi({ middleware: [guard] });
//                                            ^^^^^
//                      same instance → shared semaphore
```

Both agents draw from the same pool of 5 model slots. This is the intended
usage for global concurrency control.

### Priority ordering

```
┌──────────────────────────────┐
│ priority 0  iteration-guard  │  ← outer (cheapest checks first)
│ priority 1  loop-detector    │
│ priority 2  spawn-guard      │
│ priority 3  concurrency-guard│  ← gates after structural checks pass
│ priority 500+ user middleware│
└──────────────────────────────┘
```

The concurrency guard sits after the spawn guard. Structural rejections
(depth limit, fan-out limit) are cheap and should fire before we block on a
semaphore wait.

---

## How It Works

### Semaphore lifecycle

```
acquire(timeoutMs)
   │
   ├─ slots available? → increment active, resolve immediately
   │
   └─ all slots taken? → enqueue waiter with timeout
         │
         ├─ another caller releases → transfer slot (FIFO), resolve
         │
         └─ timeout fires first → reject with Error
               (timed-out waiter skipped on future release)

release()
   │
   ├─ active <= 0? → throw (double-release bug)
   │
   ├─ waiters queued? → skip timed-out, transfer slot to first live waiter
   │
   └─ no waiters? → decrement active
```

### Slot transfer invariant

When a slot is transferred from a releaser to a queued waiter, the active
count stays the same — there is no decrement-then-increment. This prevents
a brief window where a third caller could steal the slot.

### Error handling

On timeout, the guard throws `KoiRuntimeError` with:

| Field | Value |
|-------|-------|
| `code` | `"TIMEOUT"` |
| `retryable` | `true` |
| `context.kind` | `"model"` or `"tool"` |
| `context.activeCount` | current active slots |
| `context.maxConcurrency` | configured limit |
| `context.acquireTimeoutMs` | configured timeout |

The `retryable: true` flag tells the engine (or a retry middleware) that the
call can be retried after backoff.

---

## API Reference

### `createConcurrencyGuard(config?)`

Factory function returning a `KoiMiddleware`.

```typescript
import { createConcurrencyGuard } from "@koi/engine";

const guard = createConcurrencyGuard({
  maxConcurrentModelCalls: 5,   // default: 5
  maxConcurrentToolCalls: 10,   // default: 10
  acquireTimeoutMs: 30_000,     // default: 30s
});
```

**Config: `ConcurrencyGuardConfig`**

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `maxConcurrentModelCalls` | `number` | `5` | Max concurrent `wrapModelCall` + `wrapModelStream` |
| `maxConcurrentToolCalls` | `number` | `10` | Max concurrent `wrapToolCall` |
| `acquireTimeoutMs` | `number` | `30_000` | How long to wait for a slot before throwing |

### `createConcurrencySemaphore(maxConcurrency)`

Low-level semaphore, exposed for advanced use cases (custom guards, testing).

```typescript
import { createConcurrencySemaphore } from "@koi/engine";

const sem = createConcurrencySemaphore(3);
await sem.acquire(5_000);  // wait up to 5s for a slot
// ... do work ...
sem.release();

sem.activeCount();   // number of held slots
sem.waitingCount();  // number of queued waiters
```

### `describeCapabilities`

Returns a `CapabilityFragment` with live active/max counts, injected into
model calls so the LLM is aware of current concurrency pressure:

```
Limits concurrent calls: model 3/5, tool 7/10
```

---

## Examples

### Basic — single agent with defaults

```typescript
import { createKoi, createConcurrencyGuard } from "@koi/engine";

const agent = await createKoi({
  middleware: [createConcurrencyGuard()],
});
```

### Multi-agent — shared global limit

```typescript
const guard = createConcurrencyGuard({ maxConcurrentModelCalls: 3 });

const agents = await Promise.all([
  createKoi({ middleware: [guard] }),
  createKoi({ middleware: [guard] }),
  createKoi({ middleware: [guard] }),
]);
// All 3 agents share 3 model slots — at most 3 concurrent API calls total
```

### Aggressive throttling for rate-limited APIs

```typescript
const guard = createConcurrencyGuard({
  maxConcurrentModelCalls: 1,   // serialize all model calls
  maxConcurrentToolCalls: 2,    // max 2 tool calls at once
  acquireTimeoutMs: 60_000,     // wait up to 60s (long queue expected)
});
```

---

## Performance

- **Zero overhead under limit**: when slots are available, `acquire()` returns
  a resolved `Promise.resolve()` — no timer allocation, no queue entry.
- **FIFO fairness**: waiters are served in order. No priority inversion.
- **Timed-out waiter cleanup**: dead waiters are skipped lazily during
  `release()` rather than eagerly removed, avoiding O(n) splice operations.
- **Slot transfer**: direct handoff from releaser to waiter avoids a brief
  window where a third caller could steal the slot.

---

## Layer Compliance

- [x] `concurrency-semaphore.ts` has zero imports (self-contained)
- [x] `concurrency-guard.ts` imports only `@koi/core` (L0) and `@koi/errors` (L0u)
- [x] No vendor types (LangGraph, OpenAI, etc.)
- [x] All interface properties are `readonly`
- [x] No banned constructs (`enum`, `any`, `as Type`, `!`)

---

## Testing

| File | Tests | Coverage |
|------|-------|----------|
| `concurrency-semaphore.test.ts` | 6 | immediate resolve, queuing, FIFO, timeout, dead-waiter skip, count tracking |
| `concurrency-guard.test.ts` | 18 | all 3 hooks, config merge, blocking, error release, cross-session sharing, streaming |

All tests use the deferred-promise pattern (deterministic, no flaky timers).

```bash
cd packages/engine && bun test concurrency
```
