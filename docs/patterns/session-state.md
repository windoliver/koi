# @koi/session-state

Per-session state management for middleware authors.

## Problem

Koi middleware instances are long-lived singletons. When middleware uses
module-scoped `let` variables to track state, that state leaks across session
boundaries:

```typescript
// BAD — module-scoped state leaks between sessions
let turnCount = 0;
let cachedMessage: string | undefined;

export function createMyMiddleware(): KoiMiddleware {
  return {
    wrapModelCall(ctx, next) {
      turnCount++;           // carries over from previous session
      cachedMessage = "..."; // stale data visible to next session
      return next(ctx);
    },
  };
}
```

This caused 5 production bugs fixed in PRs #853, #862-864:

| Bug | Package | Impact |
|-----|---------|--------|
| Ghost messages | middleware-compactor | Stale cached restore injected into new sessions |
| Skewed refresh | middleware-hot-memory | Turn counters carried over, wrong memories injected |
| Concurrent wipe | middleware-user-model | Shared state wiped while other sessions active |
| Duplicate turns | middleware-conversation | Same message captured twice across model calls |
| Budget bypass | middleware-ace | Structured playbooks injected without checking remaining budget |

## Solution

`@koi/session-state` provides a `createSessionState<T>()` factory that makes
the correct pattern the default:

```typescript
import { createSessionState } from "@koi/session-state";

const state = createSessionState(() => ({
  turnCount: 0,
  cachedMessage: undefined as string | undefined,
}));

export function createMyMiddleware(): KoiMiddleware {
  return {
    onSessionStart(ctx) {
      // Lazily creates fresh state for this session
      state.getOrCreate(ctx.session.sessionId);
    },
    wrapModelCall(ctx, next) {
      // Isolated per-session — no cross-session leaks
      state.update(ctx.session.sessionId, (s) => ({
        ...s,
        turnCount: s.turnCount + 1,
      }));
      return next(ctx);
    },
    onSessionEnd(ctx) {
      // Explicit cleanup
      state.delete(ctx.session.sessionId);
    },
  };
}
```

## API

```typescript
import { createSessionState } from "@koi/session-state";
import type { SessionStateManager, SessionStateConfig } from "@koi/session-state";

const state: SessionStateManager<T> = createSessionState(factory, config?);
```

| Method | Returns | Description |
|--------|---------|-------------|
| `getOrCreate(sessionId)` | `T` | Returns existing state or creates via factory |
| `get(sessionId)` | `T \| undefined` | Returns existing state or undefined |
| `update(sessionId, fn)` | `void` | Applies immutable update. No-op if missing |
| `delete(sessionId)` | `boolean` | Removes state. Returns false if not found |
| `clear()` | `void` | Removes all session state |
| `size` | `number` | Number of active sessions |

### Configuration

```typescript
const state = createSessionState(() => initialState, {
  maxSessions: 500,                        // default: 1000
  onEvict: (id) => log.warn("evicted", id) // observability callback
});
```

When `maxSessions` is exceeded, the oldest session (FIFO by insertion order)
is evicted. This prevents unbounded memory growth if `onSessionEnd` is not
called (e.g., crashed sessions).

## What this enables

### For middleware authors

- **Correct by default** — no more remembering to reset `let` variables in
  `onSessionStart`. State is automatically isolated per session.
- **Bounded memory** — FIFO eviction prevents memory leaks from orphaned
  sessions. No need to implement your own cleanup logic.
- **Type-safe** — the factory return type flows through all operations.
  `update()` enforces immutable transformations at the type level.
- **Observable** — `onEvict` callback enables logging and alerting when
  sessions are evicted, surfacing potential lifecycle bugs.

### For agent builders

- **Safe multi-session reuse** — middleware instances can serve sequential
  and concurrent sessions without ghost state from previous sessions.
- **Predictable behavior** — agents don't hallucinate based on a previous
  session's cached state or stale counters.
- **Simpler debugging** — each session's state is inspectable via `get()`,
  making it easy to diagnose session-specific issues.

### For the platform

- **Systemic prevention** — eliminates the entire class of session-isolation
  bugs at the framework level, rather than fixing them one middleware at a time.
- **Consistent pattern** — new middleware follows one pattern instead of
  each author inventing their own session-keyed Map.

## Architecture

- **Layer:** L0u (utility) — depends only on `@koi/core`
- **Location:** `packages/lib/session-state/`
- **Size:** ~70 LOC source, ~130 LOC tests
- **Performance:** All operations are O(1) (`Map.get`, `Map.set`, FIFO via
  `Map.keys().next()`)
