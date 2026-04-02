# @koi/event-trace

KoiMiddleware that records every model call and tool call to an ATIF trajectory document.

## Why it exists

The harness (#1188) is Koi's incremental bootloader. It needs trajectory recording from
day 1 so that:

- Golden query E2E tests can assert on trajectory structure (not just final output)
- VCR cassettes can record/replay full request/response pairs
- The test CLI debug view can show per-turn trace data
- Every new package that lands is immediately observable

Without event-trace, Phase 1 and Phase 2 development fly blind.

## Layer position

```
L0  @koi/core
    ├── RichTrajectoryStep, TrajectoryDocumentStore    (contracts)
    ├── TraceEventKind, TraceEvent, TurnTrace          (per-event types)
    └── KoiMiddleware                                  (interposition contract)

L0u @koi/errors ─── isContextOverflowError
L0u @koi/hash ───── contentHash (for step IDs)

L2  @koi/event-trace ◄── THIS PACKAGE
    ├── ATIF types (discriminated unions, ATIF-v1.6)
    ├── Bidirectional mappers (Rich ↔ ATIF)
    ├── AtifDocumentStore (TrajectoryDocumentStore impl)
    └── EventTraceMiddleware (observe phase, turn-based flush)
```

**Dependencies**: `@koi/core` (L0), `@koi/errors` (L0u), `@koi/hash` (L0u).
No external dependencies — ATIF types implemented from the Harbor RFC spec.

## Architecture decisions

### 1. Shared trajectory store — harness owns lifecycle, event-trace writes

The `TrajectoryDocumentStore` (L0 interface) is the shared storage between event-trace
and the harness. The ownership contract:

```
Harness (L3, #1188)                    Event-trace (L2, #1274)
─────────────────                      ───────────────────────
1. Creates the store instance          Receives store via config
2. Passes store to event-trace         Writes RichTrajectorySteps
3. Writes per-middleware DebugSpans    (can't see middleware flow)
4. Exposes runtime.getTrajectoryStore()
5. Test CLI reads store for /debug
```

```typescript
// Harness creates and shares the store:
const store = createInMemoryAtifDocumentStore({ agentName: "my-agent" });
const { middleware } = createEventTraceMiddleware({ store, docId, agentName: "my-agent" });
const middlewares = [middleware, ...otherMiddlewares];

// Both write to the same store:
// - event-trace writes model/tool call steps (via middleware hooks)
// - harness writes per-middleware DebugSpans (via compose instrumentation)
// - TUI debug view and ACE read from the same store
```

The harness (L3) can import `@koi/event-trace` (L2) directly — L3 may depend on any
layer. Consumers use event-trace's ATIF mapper to convert to `AtifDocument` for export.

### 2. Observe phase, concurrent:false, priority 100

Event-trace is a pure observer — it never mutates requests or blocks calls. The observe
phase ensures errors are silently swallowed (tracer bugs never crash the agent). Duration
captures engine-level latency, which is what ATIF `duration_ms` represents. Pipeline-level
tracing is deferred to Phase 3's OTel integration.

### 3. Turn-based flush (no timers)

Steps accumulate within a turn and flush to the store on `onAfterTurn` and `onSessionEnd`.
No `setInterval`, no timer cleanup, fully deterministic, trivially testable. Consistent with
`@koi/context-manager`'s turn-based design. For Phase 1's in-memory store, timer-based
flushing has zero benefit.

### 4. Write-behind buffer

Non-blocking append on the hot path; batched flush to store. This keeps the middleware
hooks fast and non-blocking.

### 5. Discriminated union ATIF types

Internal types use discriminated unions by `source` field: `AtifAgentStep | AtifUserStep |
AtifSystemStep | AtifToolStep`. Each variant carries only its relevant fields. A thin
serialization layer maps to/from the flat ATIF JSON spec with optional fields. Round-trip
tests verify correctness.

### 6. Content capture strategy

- **Model requests**: Last user message + metadata (`totalMessages`, `estimatedTokens`).
  Full prompts would duplicate the entire conversation history per step (~100KB/step).
- **Tool outputs**: Configurable truncation (default 8KB). Head+tail: first 4KB + `...` +
  last 4KB. Sets `RichContent.truncated` and `RichContent.originalSize`.
- **Model responses**: Stored in full (typically small compared to prompts).

### 7. Eviction: size cap + turn window

- **maxSteps** (default 500): Oldest steps dropped on flush for smooth, predictable eviction.
- **maxSizeBytes** (default 10MB): Hard safety net via binary-search pruning with incremental
  size tracking. O(log n) instead of v1's O(n^2) serialization loop.

## ATIF: Agent Trajectory Interchange Format

ATIF v1.6 is a JSON schema spec from the
[Harbor framework RFC](https://github.com/harbor-framework/harbor/blob/main/docs/rfcs/0001-trajectory-format.md)
(Apache-2.0). Koi implements the types independently (~100 LOC) — no Harbor dependency.

Koi extensions to ATIF v1.6 (stored as top-level fields per spec's extensibility):
- `duration_ms`: Step duration in milliseconds
- `outcome`: `"success" | "failure" | "retry"`

## Public API

### `createEventTraceMiddleware(config): EventTraceHandle`

Factory returning `{ middleware, getTrajectory, getStepCount }`.

- `middleware` — wire as first middleware in the chain (priority 100, phase "observe")
- `getTrajectory(sessionId)` — returns accumulated `RichTrajectoryStep[]`
- `getStepCount(sessionId)` — returns current step count

### `createInMemoryAtifDocumentStore(config): TrajectoryDocumentStore`

In-memory store implementing the L0 `TrajectoryDocumentStore` contract.

### `createAtifDocumentStore(config, delegate): TrajectoryDocumentStore`

Store backed by a pluggable `AtifDocumentDelegate` for persistence.

### `createWriteBehindBuffer(store, config?): AtifWriteBehindBuffer`

Non-blocking buffer with auto-flush at batch size and periodic timer.

### ATIF Mappers

- `mapRichTrajectoryToAtif(steps, options): AtifDocument`
- `mapAtifToRichTrajectory(doc): readonly RichTrajectoryStep[]`
- `mapRichToAtifDocument(steps, options): AtifDocument`
- `mapAtifDocumentToRich(doc): readonly RichTrajectoryStep[]`

### Utilities

- `pickDefined<T>(obj): Partial<T>`
- `sumOptional(...values): number | undefined`
- `truncateContent(text, maxBytes?): RichContent`

## What it does NOT own

- **Per-middleware span tracing** (L3 harness: `DebugSpanResponse` with name, duration,
  nextCalled, phase, children). The harness wraps each middleware with instrumentation
  when composing the chain — event-trace can't see other middleware because it IS a
  middleware. Both per-middleware spans and event-trace steps feed into the same
  `TrajectoryDocumentStore` for ACE and the TUI debug waterfall.
- Trajectory analysis / reflection / curation (Phase 3: ACE middleware)
- Persistent storage backends (Phase 3: Nexus trajectory store)
- OpenTelemetry span export (Phase 3: @koi/observability)
- TUI waterfall rendering (Phase 2j: @koi/tui debug view consumes this data)
- Harbor framework runtime — zero dependency, types only
- Cursor-based event queries (Phase 2: requires SnapshotChainStore)

## Tests

- Round-trip: per-variant `Rich -> ATIF -> Rich` with lossy-field documentation
- Error resilience: mock store failures, verify middleware continues
- Concurrent tool calls: overlapping async tool calls with controlled timing
- Stream error paths: happy, error mid-stream, empty stream
- Store operations: append, getDocument, getStepRange, getSize, prune, maxSteps eviction
- Content truncation: tool outputs, model request capture
- Utility functions: pickDefined, sumOptional edge cases

## Known limitations

- **docId is caller's responsibility.** `createEventTraceMiddleware` takes a fixed `docId`.
  Multiple sessions writing to the same `docId` is intentional (conversation-scoped
  documents that accumulate across engine sessions). Callers must use distinct `docId`
  values when session isolation is required. The middleware does NOT enforce one-session-per-doc.

- **Append idempotency is in-memory only.** The batch token dedup that prevents duplicate
  steps on retry lives in the store's process memory. If the process crashes after a
  successful delegate write but before the token is recorded, a restart + retry will
  append duplicate steps. Phase 3 fix: persist idempotency tokens in the delegate
  (e.g., as a field on the ATIF document) so dedup survives process boundaries.

## Reference

- [Harbor ATIF RFC](https://github.com/harbor-framework/harbor/blob/main/docs/rfcs/0001-trajectory-format.md) -- ATIF-v1.6 spec (Apache-2.0)
- `archive/v1/packages/mm/middleware-ace/src/atif.ts` -- v1 types + mappers (322 LOC)
- `archive/v1/packages/mm/middleware-ace/src/atif-store.ts` -- v1 document store (203 LOC)
- `archive/v1/packages/observability/middleware-event-trace/src/event-trace.ts` -- v1 middleware (229 LOC)
- `packages/kernel/core/src/rich-trajectory.ts` -- v2 L0 types
- `packages/kernel/core/src/snapshot-time-travel.ts` -- v2 per-event trace types
