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
  │     └─ YES → throw KoiRuntimeError("TIMEOUT", "aborted")
  │
  ├─ 2. Resolve timeout for this toolId
  │     ├─ toolTimeouts.get(toolId) → per-tool override
  │     └─ fallback to defaultTimeoutMs → global default
  │     └─ undefined → no timeout, forward signal unchanged
  │
  ├─ 3. Compose signal (only if timeout configured)
  │     └─ AbortSignal.any([request.signal, AbortSignal.timeout(ms)])
  │
  ├─ 4. Promise.race([next(request), rejectOnAbort(signal)])
  │     │
  │     ├─ SUCCESS → return response unchanged (pure transparency)
  │     │
  │     └─ FAILURE → classify error
  │           ├─ DOMException "AbortError"   → throw KoiRuntimeError("TIMEOUT")
  │           ├─ DOMException "TimeoutError" → throw KoiRuntimeError("TIMEOUT")
  │           └─ other                       → re-throw as-is
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
| Abort signal fires | `DOMException.name === "AbortError"` | Throws `KoiRuntimeError("TIMEOUT")` with `retryable: false` |
| Timeout fires | `DOMException.name === "TimeoutError"` | Throws `KoiRuntimeError("TIMEOUT")` with `retryable: false` |
| Signal pre-aborted | `signal.aborted` check | Throws `KoiRuntimeError("TIMEOUT")` immediately, handler not called |
| Invalid config | Construction time | Throws `KoiRuntimeError("VALIDATION")` |

## Testing

- **Config validation**: 7 tests (negative, NaN, Infinity, zero, per-tool invalid, error type)
- **Abort matrix**: 6 scenarios (pre-aborted, mid-abort, abort-during-next race, timeout, signal race, missing signal, both present)
- **Error propagation**: 8 shapes (Error, KoiRuntimeError, string, null, object, AbortError, TimeoutError, non-standard DOMException)
- **Transparency**: successful calls pass through unchanged (referential equality)
- **Governance integration**: 4 tests proving outer middleware sees correct success/failure signals

40 tests, 100% line coverage, 100% function coverage.

## Design decisions

1. **Errors thrown, not normalized into ToolResponse** — Outer middleware (governance extension) distinguishes success/failure by whether `next()` throws. Normalizing errors into fulfilled ToolResponse would corrupt governance accounting. Error-to-ToolResponse normalization belongs at the engine adapter boundary.
2. **`AbortSignal.any()` + `Promise.race`** — Web standard signal composition (Bun 1.3.x). `Promise.race` with `rejectOnAbort()` ensures timeout fires even when tools ignore the signal. `rejectOnAbort` checks `signal.aborted` before attaching listener to prevent the race where the signal fires between the pre-check and `addEventListener`.
3. **Config validated at construction** — `AbortSignal.timeout()` throws `RangeError` for negative/NaN/Infinity. Validating early produces a clear `KoiRuntimeError("VALIDATION")` instead of an opaque runtime crash.
4. **Conditional signal composition** — only allocate `AbortSignal.any()` when timeout is configured. Zero overhead on the happy path.
5. **Pure transparency on success** — no metadata enrichment. Timing belongs in observe-phase middleware.
6. **`retryable: false` for timeout/abort** — the tool may still be running in the background after `Promise.race` returns. Automatic retry could cause duplicate side effects.
7. **`describeCapabilities` returns `undefined`** — tool execution wrapping is infrastructure, invisible to the LLM.

## Layer compliance

- [x] Runtime deps: `@koi/core` (L0) + `@koi/errors` (L0u)
- [x] No imports from `@koi/engine` or peer L2 packages
- [x] All interface properties are `readonly`
- [x] No vendor types in public API
