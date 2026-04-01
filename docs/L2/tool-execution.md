# @koi/tool-execution — Per-Call Tool Execution Middleware

`@koi/tool-execution` is an L2 middleware package implementing `KoiMiddleware.wrapToolCall`
for per-call tool dispatch orchestration. It owns abort propagation, error normalization,
and deterministic response shaping for every tool call in the pipeline.

## Why it exists

Every tool call can fail in multiple ways: the tool throws, the request is aborted,
a timeout fires, or the tool returns malformed output. Without a dedicated execution
wrapper, each engine adapter must independently handle these failure modes — leading
to inconsistent error shapes, conversation corruption on abort, and duplicated logic.

This package ensures that **every tool call produces a valid `ToolResponse`**, regardless
of how the underlying tool behaves. It is the last middleware before the terminal tool
handler and the first to see the tool's result.

## What this owns

- Per-call tool dispatch through `KoiMiddleware.wrapToolCall`
- Abort propagation from `ToolRequest.signal` via `AbortSignal.any()` composition
- Per-tool timeout enforcement via `AbortSignal.timeout()`
- Error normalization: arbitrary tool failures → deterministic `ToolResponse`
- Distinguishes abort vs timeout vs tool error via `DOMException.name`

## What this does NOT own

- Permission checking → `@koi/permissions`
- Hook dispatch → `@koi/hooks`
- Turn continuation / loop control → `@koi/query-engine`
- Request-time tool visibility filtering → L1
- Batch scheduling, sibling cancellation, global concurrency → out of scope (Phase 1)
- Streaming tool result chunks → out of scope under current `ToolResponse` contract

## Layer position

```
L0  @koi/core                ─ KoiMiddleware, ToolRequest, ToolResponse, TurnContext
L0u @koi/errors              ─ toKoiError(), formatToolError(), KoiRuntimeError
L0u @koi/execution-context   ─ runWithExecutionContext(), SpanRecorder
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
  │     └─ YES → return ToolResponse with abort metadata
  │
  ├─ 2. Resolve timeout for this toolId
  │     ├─ toolTimeouts.get(toolId) → per-tool override
  │     └─ fallback to defaultTimeoutMs → global default
  │     └─ undefined → no timeout, forward signal unchanged
  │
  ├─ 3. Compose signal (only if timeout configured)
  │     └─ AbortSignal.any([request.signal, AbortSignal.timeout(ms)])
  │
  ├─ 4. Call next(request) with composed signal
  │     │
  │     ├─ SUCCESS → return response unchanged (pure transparency)
  │     │
  │     └─ FAILURE → classify via DOMException.name
  │           ├─ "AbortError"   → ToolResponse with abort metadata
  │           ├─ "TimeoutError" → ToolResponse with timeout metadata
  │           └─ other          → ToolResponse with error metadata
  │                               (uses toKoiError + formatToolError)
  │
  └─ Every path returns a valid ToolResponse. Never throws on tool failure.
```

### Internal discriminated union

```typescript
type ToolCallOutcome =
  | { readonly kind: "success"; readonly response: ToolResponse }
  | { readonly kind: "error"; readonly message: string; readonly cause?: unknown }
  | { readonly kind: "timeout"; readonly timeoutMs: number }
  | { readonly kind: "aborted"; readonly reason: unknown };
```

Used internally for type-safe classification. Mapped to `ToolResponse` at the boundary.

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
  includeStackInResponse: false, // production: hide stack traces
});
```

## Configuration

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `defaultTimeoutMs` | `number \| undefined` | `undefined` | Global timeout for all tool calls. No timeout when absent. |
| `toolTimeouts` | `Record<string, number>` | `{}` | Per-tool timeout overrides. Takes precedence over default. |
| `includeStackInResponse` | `boolean` | `false` | Include stack trace in error responses. Enable for development. |

## Error handling

| Failure mode | Detection | ToolResponse.output | ToolResponse.metadata |
|---|---|---|---|
| Tool throws Error | `catch` block | `formatToolError()` message | `{ _error: { kind: "tool_error", code, retryable } }` |
| Abort signal fires | `DOMException.name === "AbortError"` | `"Tool call aborted"` | `{ _error: { kind: "aborted" } }` |
| Timeout fires | `DOMException.name === "TimeoutError"` | `"Tool call timed out after Xms"` | `{ _error: { kind: "timeout", timeoutMs } }` |
| Signal pre-aborted | `signal.aborted` check | `"Tool call aborted"` | `{ _error: { kind: "aborted" } }` |

## Testing

- **Abort matrix**: 5 scenarios (pre-aborted, mid-abort, timeout, race, missing signal)
- **Error shapes**: 8 variants (Error, KoiRuntimeError, string, null, object, AbortError, TimeoutError, malformed)
- **Transparency**: successful calls pass through unchanged
- **Integration**: mock middleware chain verifies guard errors propagate unchanged

## Design decisions

1. **`AbortSignal.any()` over custom controller** — web standard, supported in Bun 1.3.x, composes parent signal with per-call timeout. First-to-abort semantics.
2. **Always return `ToolResponse`, never throw** — prevents conversation corruption when abort fires mid-execution (LangChain.js #8570).
3. **Internal discriminated union** — type-safe classification with exhaustive `switch`, mapped to `ToolResponse` at the boundary. Inspired by Vercel AI SDK's 3-part stream taxonomy.
4. **Conditional signal composition** — only allocate `AbortSignal.any()` when timeout is configured. Zero overhead on the happy path.
5. **Pure transparency on success** — no metadata enrichment on the happy path. Timing belongs in observe-phase middleware.
6. **`describeCapabilities` returns `undefined`** — tool execution wrapping is infrastructure, invisible to the LLM.

## Layer compliance

- [x] Runtime deps: `@koi/core` (L0) + `@koi/errors` (L0u) + `@koi/execution-context` (L0u)
- [x] No imports from `@koi/engine` or peer L2 packages
- [x] All interface properties are `readonly`
- [x] No vendor types in public API
