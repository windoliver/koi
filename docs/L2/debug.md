# @koi/debug — Runtime Debugging with Breakpoints, Step/Pause, Inspection

`@koi/debug` is an L2 feature package that provides runtime debugging capabilities
for Koi agents. It implements the process-model equivalent of `ptrace` — single-attach
debug sessions with breakpoints, step-through, state inspection, and read-only observers.

---

## Why it exists

Before this package, there was no way to pause a running agent, inspect its internal
state, or step through its execution turn-by-turn. Debugging meant adding `console.log`
calls and restarting. The process model gap analysis ([#630](https://github.com/windoliver/koi/issues/630))
identified this as the "ptrace equivalent" missing from Koi's process abstraction.

This package:

1. **Provides runtime attach/detach** — debug sessions can be hot-wired into a running
   agent via `dynamicMiddleware` without restarting
2. **Implements structured breakpoints** — predicate-based (turn, tool_call, error,
   event_kind) with Promise-based gating that pauses the engine loop
3. **Enables state inspection** — token-filtered metadata snapshots + on-demand
   component deep-dive with pagination
4. **Supports read-only observers** — multiple `DebugObserver` instances can watch a
   session without affecting control flow
5. **Enforces single-attach semantics** — one debug session per agent, preventing
   conflicting control signals

---

## Architecture

### Layer position

```
L2 @koi/debug
    imports: @koi/core (L0)
    imports: @koi/test-utils (L0u, devDependency only)
    peer L2 imports: none
```

### Internal module map

```
index.ts                  ← public re-exports
│
├── constants.ts           ← DEBUG_MIDDLEWARE_NAME, priority, buffer size
├── types.ts               ← InternalDebugState, GateControl, BreakpointEntry
├── event-ring-buffer.ts   ← bounded circular buffer for EngineEvent history
├── breakpoint-matcher.ts  ← pure function: evaluate predicate against event context
├── debug-middleware.ts    ← KoiMiddleware + DebugController interface
├── debug-session.ts       ← DebugSession state machine (attached → paused → detached)
├── debug-observer.ts      ← read-only observer sharing session's event buffer
└── create-debug-attach.ts ← public factory: attach / observe / check / clearAll
```

### Data flow

```
Engine turn loop
  │
  ▼
┌─────────────────────────────────┐
│  debug-middleware (priority 50)  │
│                                 │
│  inactive? → next(request)      │ ← zero overhead when not debugging
│  active?   → record event       │
│           → evaluate breakpoints │
│           → gate (Promise) if hit│ ← blocks engine loop until step/resume
└─────────┬───────────────────────┘
          │
          ▼
┌──────────────────┐     ┌──────────────────┐
│  DebugSession    │     │  DebugObserver(s) │
│  (single-attach) │     │  (read-only)      │
│                  │     │                   │
│  step / resume   │     │  inspect          │
│  breakOn         │     │  events           │
│  inspect         │     │  onDebugEvent     │
│  detach          │     │  detach           │
└──────────────────┘     └──────────────────┘
```

---

## API

### `createDebugAttach(config)`

Attach a debug session to an agent. Returns `Result<DebugAttachResult, KoiError>`.

```typescript
import { createDebugAttach } from "@koi/debug";

const result = createDebugAttach({ agent, bufferSize: 500 });
if (!result.ok) {
  // result.error.code === "CONFLICT" if already attached
  return;
}

const { session, middleware } = result.value;
// Inject middleware via dynamicMiddleware callback
```

| Parameter | Type | Default | Description |
|---|---|---|---|
| `agent` | `Agent` | required | The agent entity to debug |
| `bufferSize` | `number` | `1000` | Event ring buffer capacity |

**Returns:** `{ session: DebugSession, middleware: KoiMiddleware }` on success,
`CONFLICT` error if the agent already has a debug session attached.

### `createDebugObserve(agentId, agent)`

Create a read-only observer for an existing debug session.

```typescript
import { createDebugObserve } from "@koi/debug";

const result = createDebugObserve(agentId("agent-1"), agent);
if (!result.ok) {
  // result.error.code === "NOT_FOUND" if no session exists
  return;
}

const observer = result.value;
const snapshot = observer.inspect();
const events = observer.events(50); // last 50 events
```

**Returns:** `DebugObserver` on success, `NOT_FOUND` error if no active session.
Multiple observers can attach to the same session simultaneously.

### `hasDebugSession(agentId)`

Check whether an agent has an active debug session.

```typescript
import { hasDebugSession } from "@koi/debug";

if (hasDebugSession(agentId("agent-1"))) {
  // session is active
}
```

**Returns:** `boolean`. Synchronous.

### `clearAllDebugSessions()`

Deactivate all active debug sessions. Intended for test cleanup only.

```typescript
import { clearAllDebugSessions } from "@koi/debug";

beforeEach(() => {
  clearAllDebugSessions();
});
```

### `matchesBreakpoint(predicate, context)`

Pure function that evaluates a `BreakpointPredicate` against a `MatchContext`.

```typescript
import { matchesBreakpoint } from "@koi/debug";

const hit = matchesBreakpoint(
  { kind: "tool_call", toolName: "web_search" },
  { event, turnIndex: 3 },
);
```

### `createEventRingBuffer(capacity)`

Create a bounded circular buffer for `EngineEvent` storage.

```typescript
import { createEventRingBuffer } from "@koi/debug";

const buffer = createEventRingBuffer(1000);
buffer.push(event);
const recent = buffer.tail(50); // last 50 events
```

---

## DebugSession lifecycle

The session follows a strict state machine:

```
            createDebugAttach()
                   │
                   ▼
            ┌──────────┐
            │ attached  │◄──── step() / resume()
            └────┬─────┘
                 │ breakpoint hit
                 ▼
            ┌──────────┐
            │  paused   │──── step() → attached (one turn)
            └────┬─────┘     resume() → attached (continue)
                 │
                 │ detach() [auto-resumes if paused]
                 ▼
            ┌──────────┐
            │ detached  │     (terminal — session is done)
            └──────────┘
```

### Lifecycle edge cases

| Scenario | Behaviour |
|---|---|
| Detach while paused | `releaseGate()` auto-resumes, state → detached, middleware deactivated |
| Agent terminates | Middleware records `done` event, releases gate if paused, emits `detached` with reason `agent_terminated` |
| Second attach to same agent | Returns `CONFLICT` error — must detach first |
| Double detach | Safe (idempotent) — second call is a no-op |
| Predicate error in breakpoint | Caught in middleware, breakpoint auto-removed, agent continues |

---

## Breakpoint predicates

All predicates are structured data (no arbitrary functions), making them serialisable:

| Kind | Matches when... | Options |
|---|---|---|
| `turn` | Turn boundary reached | `turnIndex?` (exact), `every?` (interval) |
| `tool_call` | Tool invocation event | `toolName?` (filter by name) |
| `error` | Any error event | — |
| `event_kind` | Specific engine event kind | `eventKind` (required) |

```typescript
// Break on every 5th turn
session.breakOn({ kind: "turn", every: 5 });

// Break when web_search tool is called
session.breakOn({ kind: "tool_call", toolName: "web_search" }, { once: true });

// Break on any error
session.breakOn({ kind: "error" });
```

---

## Inspection

Two-level inspection avoids expensive serialisation of large component state:

1. **`inspect(tokens?)`** — returns `DebugSnapshot` with lightweight `ComponentMetadata[]`
   (token names, type hints, sizes, serialisability flag). No component data is fetched.

2. **`inspectComponent(token, { limit, offset })`** — returns paginated `ComponentSnapshot`
   with actual data. Arrays and Maps are sliced; scalars returned as-is.

```typescript
const snapshot = session.inspect();
// snapshot.components = [{ token: "mailbox", typeHint: "object", approximateBytes: 1234, serializable: true }]

const detail = session.inspectComponent(MAILBOX, { limit: 10, offset: 0 });
if (detail.ok) {
  // detail.value.data, detail.value.hasMore, detail.value.totalItems
}
```

---

## Performance properties

| Scenario | Overhead | Notes |
|---|---|---|
| No debug session (middleware inactive) | **0** | Early `return next(request)` — zero allocation |
| Active, no breakpoints | ~0.05ms | Event recording to ring buffer only |
| Active, 1 breakpoint | ~0.1ms | One predicate evaluation per event |
| Active, 100 breakpoints | ~1ms | Linear scan; budget allows up to ~100 |
| Breakpoint hit (paused) | blocks | Engine loop awaits Promise gate |

The middleware runs at **priority 50** (outer onion layer) and checks `controller.isActive()`
as its first operation. When no debug session exists, the middleware is a no-op pass-through.

---

## Examples

### Attach, set breakpoint, step through

```typescript
import { createDebugAttach } from "@koi/debug";

const result = createDebugAttach({ agent });
if (!result.ok) throw new Error(result.error.message);

const { session, middleware } = result.value;

// Inject middleware into engine via dynamicMiddleware
// (see @koi/engine dynamicMiddleware option)

// Break on tool calls
const bp = session.breakOn({ kind: "tool_call" });

// Listen for pause events
session.onDebugEvent((event) => {
  if (event.kind === "paused") {
    const snapshot = session.inspect();
    console.log("Paused at turn", snapshot.turnIndex);
    session.step(); // advance one turn
  }
});

// When done
session.detach();
```

### Read-only observer

```typescript
import { createDebugAttach, createDebugObserve } from "@koi/debug";

// Attach (e.g., from a CLI debug command)
createDebugAttach({ agent });

// Observe (e.g., from a dashboard WebSocket)
const result = createDebugObserve(agent.pid.id, agent);
if (!result.ok) return;

const observer = result.value;
const snapshot = observer.inspect();
const events = observer.events(100);

// Clean up observer without affecting the session
observer.detach();
```

---

## Design decisions

| Decision | Rationale |
|---|---|
| Single-attach per agent | Prevents conflicting step/resume signals from multiple controllers |
| Promise-based gate (not polling) | Zero CPU during pause; instant resume on `step()`/`resume()` |
| Structured predicates (no functions) | Serialisable over IPC/WebSocket; safe — no arbitrary code execution |
| Ring buffer (not unbounded array) | Bounded memory; 1000 events default covers ~100 turns |
| Token-filtered inspection | Avoids serialising entire agent state; metadata-first, data-on-demand |
| Auto-resume on detach | Prevents permanently stuck agents if debugger disconnects |
| Priority 50 (outermost) | Debug middleware wraps everything — sees all events before other middleware |

---

## Layer compliance

```
L2 @koi/debug
    runtime deps: @koi/core (L0) only
    devDeps: @koi/test-utils (L0u)
    zero L1 imports
    zero peer L2 imports
    ✓ safe to import from any L2, L3, or application code
```

---

## Related

- [`@koi/core` debug types](../../packages/core/src/debug.ts) — L0 contracts (DebugSession, DebugObserver, BreakpointPredicate, etc.)
- [`@koi/engine` dynamicMiddleware](../../packages/engine/src/koi.ts) — L1 turn-boundary hook for hot-wiring debug middleware
- Issue [#630](https://github.com/windoliver/koi/issues/630) — process model gap analysis that motivated this package
