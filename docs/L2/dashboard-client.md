# `@koi/dashboard-client` (L2)

Typed client SDK for the dashboard HTTP + SSE API. Wraps `fetch` and an injectable SSE transport adapter so that callers never assemble URLs, never parse JSON envelopes, and always receive typed payloads from `@koi/dashboard-types`.

## What it provides

- `createDashboardClient({ baseUrl, fetch?, sse? })` — factory returning:
  - `listAgents(): Promise<Result<readonly AgentStatus[]>>`
  - `getAgent(id): Promise<Result<AgentStatus | undefined>>`
  - `listSessions(): Promise<Result<readonly SessionSummary[]>>`
  - `getMetrics(query): Promise<Result<readonly MetricPoint[]>>`
  - `getTrace(turnId): Promise<Result<TraceView | undefined>>`
  - `subscribe(topics, onEvent): Unsubscribe` — SSE subscription, returns a teardown.
- All methods return `Result<T, KoiError>` from `@koi/core`. HTTP and parse failures map to `KoiError` codes — they never throw to the caller.
- Optional `fetch` and `sse` adapter injection so the package stays runtime-agnostic (Bun, Node 22+, browser, JSDOM tests).

## Not in scope

- Reconnect/backoff, debounce, terminal decoding, session caching — those v1 helpers were over-scoped for the v2 contract issue and will arrive as separate L2 utilities only when a UI consumer needs them (Rule of Three).
- Authentication — the caller passes a pre-built `fetch` (or sets headers via `init`). The SDK does not handle credential exchange.
- WebSockets are out of scope for this package. SSE is the live transport for dashboard updates; any future alternate transport would live in a sibling adapter.

## Layer

L2. Imports `@koi/core` and `@koi/dashboard-types` only. No engine/runtime imports.

## Reliability

- Each HTTP call wraps `fetch` and converts non-2xx, network errors, and JSON parse failures into `KoiError` (codes: `NETWORK_ERROR`, `PARSE_ERROR`, `NOT_FOUND`, `INTERNAL_ERROR`).
- WS subscriber dispatches typed events; unknown frames are ignored (forward compatibility).
- The SDK does not retry — callers compose retry policy via `@koi/errors` if needed.
