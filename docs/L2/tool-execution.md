# @koi/tool-execution — Per-Call Tool Execution Middleware

`@koi/tool-execution` is an L2 middleware package implementing `KoiMiddleware.wrapToolCall`
for per-call tool dispatch orchestration. It owns abort propagation, per-tool timeout
enforcement, and DOMException-to-KoiRuntimeError classification.

## Why it exists

Every tool call can fail via abort signal or timeout. Without a dedicated execution
wrapper, each engine adapter must independently compose abort signals, enforce per-tool
timeouts, and classify DOMException variants — leading to duplicated logic and
inconsistent error shapes.

This middleware handles timeout/abort enforcement and error classification while
**preserving the error signal for outer middleware**. It does NOT normalize errors
into ToolResponse — that responsibility belongs to the engine adapter at the outermost
boundary. Normalizing here would corrupt governance accounting (outer middleware
distinguishes fulfilled next() from rejected next() to record success vs failure).

## What this owns

- Per-call tool dispatch through `KoiMiddleware.wrapToolCall`
- Abort propagation from `ToolRequest.signal` via `AbortSignal.any()` composition
- Per-tool timeout enforcement via `AbortSignal.timeout()` + `Promise.race`
- DOMException classification: AbortError/TimeoutError → `KoiRuntimeError("TIMEOUT")`
- Tool errors re-thrown as-is to preserve outer middleware accounting
- Config validation at construction time (rejects invalid timeout values)

## What this does NOT own

- Error-to-ToolResponse normalization → engine adapter (outermost boundary)
- Permission checking → `@koi/permissions`
- Hook dispatch → `@koi/hooks`
- Turn continuation / loop control → `@koi/query-engine`
- Request-time tool visibility filtering → L1
- Batch scheduling, sibling cancellation, global concurrency → out of scope (Phase 1)
- Streaming tool result chunks → out of scope under current `ToolResponse` contract

## Layer position

```
L0  @koi/core                ─ KoiMiddleware, ToolRequest, ToolResponse, TurnContext
L0u @koi/errors              ─ KoiRuntimeError
L2  @koi/tool-execution      ─ this package
```

## Architecture

### Middleware placement

- **Phase**: `"resolve"` (core business logic, not intercept/observe)
- **Priority**: `100` (runs after L1 guards at 0-2, before business middleware at 500)

### Execution flow

```
wrapToolCall(ctx, request, next)
  │
  ├─ 1. Check: is request.signal already aborted?
  │     └─ YES → throw DOMException("AbortError") preserving signal.reason
  │
  ├─ 2. Resolve timeout for this toolId
  │     ├─ toolTimeouts.get(toolId) → per-tool override
  │     └─ fallback to defaultTimeoutMs → global default
  │     └─ undefined → no timeout, forward signal unchanged
  │
  ├─ 3. Compose signal via manual AbortController + parent forwarding
  │     └─ Timer: setTimeout + clearTimeout (cancellable, no timer leak)
  │     └─ Parent: explicit listener on parent signal (fully removable)
  │
  ├─ 4. Promise.race([next(request), racePromise])
  │     │
  │     ├─ SUCCESS → return response unchanged (pure transparency)
  │     │
  │     └─ FAILURE → classify error (signal-gated)
  │           ├─ Our timer fired    → throw KoiRuntimeError("EXTERNAL")
  │           ├─ Parent abort fired → re-throw DOMException (reason preserved)
  │           └─ Tool error         → re-throw as-is
  │
  ├─ finally: cleanup() clears timer + removes all listeners
  │
  └─ Errors propagate to outer middleware. Engine adapter handles ToolResponse.
```

## Quick start

```typescript
import { createToolExecution } from "@koi/tool-execution";

// Minimal — just abort propagation, no timeout
const middleware = createToolExecution();

// With global timeout
const withTimeout = createToolExecution({
  defaultTimeoutMs: 30_000,
});

// With per-tool overrides
const withOverrides = createToolExecution({
  defaultTimeoutMs: 30_000,
  toolTimeouts: {
    "exec:run": 60_000,     // code execution gets 60s
    "fs:read": 5_000,       // file read gets 5s
  },
});
```

## Configuration

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `defaultTimeoutMs` | `number \| undefined` | `undefined` | Global timeout for all tool calls. No timeout when absent. Must be finite and positive. |
| `toolTimeouts` | `Record<string, number>` | `{}` | Per-tool timeout overrides. Takes precedence over default. Each value must be finite and positive. |

Invalid config values (negative, NaN, Infinity, zero) throw `KoiRuntimeError("VALIDATION")` at construction time.

## Error handling

| Failure mode | Detection | Behavior |
|---|---|---|
| Tool throws any error | `catch` block | Re-thrown as-is — preserves error type for governance |
| Our timeout fires | Sentinel-tagged reason on composed signal | Throws `KoiRuntimeError("EXTERNAL")` with `retryable: false` |
| Parent abort fires | `signal.aborted` + reason is NOT our sentinel | Re-throws `DOMException("AbortError")` preserving original reason |
| Signal pre-aborted | `signal.aborted` check | Throws `DOMException("AbortError")` preserving reason, handler not called |
| Invalid config | Construction time | Throws `KoiRuntimeError("VALIDATION")` |

**Why EXTERNAL, not TIMEOUT?** The engine maps `TIMEOUT` → `stopReason: "max_turns"` → `"success"` outcome. A tool-level timeout must surface as `stopReason: "error"`, which `EXTERNAL` provides. `TIMEOUT` is reserved for engine-level budget exhaustion (iteration guard).

## Testing

- **Config validation**: 7 tests (negative, NaN, Infinity, zero, per-tool invalid, error type)
- **Abort matrix**: 6 scenarios (pre-aborted, mid-abort, abort-during-next race, timeout, signal race, missing signal, both present)
- **Error propagation**: 8 shapes (Error, KoiRuntimeError, string, null, object, AbortError, TimeoutError, non-standard DOMException)
- **Transparency**: successful calls pass through unchanged (referential equality)
- **Governance integration**: 5 tests proving outer middleware sees correct success/failure signals
- **Listener + timer cleanup**: 3 tests (reused signals, error path, timer leak)
- **Signal-gated classification**: 3 tests (tool-originated DOMExceptions not misclassified)
- **Abort reason preservation**: 4 tests (user_cancel, shutdown, token_limit, pre-aborted)

49 tests, 98% line coverage, 100% function coverage.

## Design decisions

1. **Errors thrown, not normalized into ToolResponse** — Outer middleware (governance extension) distinguishes success/failure by whether `next()` throws. Normalizing errors into fulfilled ToolResponse would corrupt governance accounting. Error-to-ToolResponse normalization belongs at the engine adapter boundary.
2. **Manual signal composition, no `AbortSignal.any()`** — `AbortSignal.any()` creates internal subscriptions on the parent signal that cannot be cleaned up. Manual parent-signal forwarding via addEventListener/removeEventListener is fully cleanable in the `finally` block.
3. **Cancellable manual timer** — `AbortSignal.timeout()` creates uncancellable timers. Manual `setTimeout`/`clearTimeout` releases timer resources immediately when the tool completes.
4. **Sentinel-tagged timeout reason** — A branded symbol distinguishes "our timer fired" from "parent signal fired" so only our timeouts become `KoiRuntimeError("EXTERNAL")`. Parent aborts (user_cancel, shutdown, token_limit) re-throw as `DOMException` preserving the original reason end-to-end.
5. **EXTERNAL error code for tool timeouts** — The engine maps `TIMEOUT` → `max_turns` (success). Tool-level timeouts must surface as `stopReason: "error"`, which `EXTERNAL` provides.
6. **Config validated at construction** — Rejects invalid timeout values with `KoiRuntimeError("VALIDATION")` instead of opaque `RangeError` at call time.
7. **Pure transparency on success** — no metadata enrichment. Timing belongs in observe-phase middleware.
8. **`retryable: false` for tool timeouts** — the tool may still be running after `Promise.race` returns. Automatic retry could cause duplicate side effects.
9. **`describeCapabilities` returns `undefined`** — tool execution wrapping is infrastructure, invisible to the LLM.

## Layer compliance

- [x] Runtime deps: `@koi/core` (L0) + `@koi/errors` (L0u)
- [x] No imports from `@koi/engine` or peer L2 packages
- [x] All interface properties are `readonly`
- [x] No vendor types in public API
