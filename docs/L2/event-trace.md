# @koi/event-trace

KoiMiddleware that records every model call and tool call to an ATIF trajectory document.

## Layer

L2 — depends on `@koi/core` (L0), `@koi/errors` (L0u), `@koi/hash` (L0u).

## Responsibility

1. **Trajectory recording** — `wrapModelCall`, `wrapModelStream`, and `wrapToolCall` hooks capture request, response, duration, and token metrics for every call.
2. **ATIF interchange** — implements ATIF v1.6 types from the [Harbor RFC](https://github.com/harbor-framework/harbor/blob/main/docs/rfcs/0001-trajectory-format.md) (Apache-2.0). No Harbor dependency — types are implemented from spec.
3. **Document store** — in-memory `TrajectoryDocumentStore` (L0 contract) for Phase 1. Nexus-backed persistence is Phase 3.
4. **Write-behind buffer** — non-blocking append on the hot path; batched flush to store.
5. **Bidirectional mapping** — `RichTrajectoryStep` (L0) ↔ `AtifStep` for interchange.

## Public API

### `createEventTraceMiddleware(config): EventTraceHandle`

Factory returning `{ middleware, getTrajectory, getStepCount }`.

- `middleware` — wire as first middleware in the chain (priority 100, phase "observe")
- `getTrajectory(sessionId)` — returns accumulated `RichTrajectoryStep[]`
- `getStepCount(sessionId)` — returns current step count

### `createInMemoryTrajectoryStore(config?): TrajectoryDocumentStore`

In-memory store implementing the L0 `TrajectoryDocumentStore` contract.

### `createWriteBehindBuffer(store, config?): AtifWriteBehindBuffer`

Non-blocking buffer with auto-flush at batch size and periodic timer.

### ATIF Mappers

- `mapRichToAtifDocument(steps, options): AtifDocument`
- `mapAtifDocumentToRich(doc): readonly RichTrajectoryStep[]`

## Not in scope

- Trajectory analysis/reflection/curation (Phase 3: ACE middleware)
- Persistent storage backends (Phase 3: Nexus trajectory store)
- OpenTelemetry span export (Phase 3: @koi/observability)
- TUI waterfall rendering (Phase 2j: @koi/tui consumes this data)
- Harbor framework runtime — zero dependency
