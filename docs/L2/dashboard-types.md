# `@koi/dashboard-types` (L0u)

Shared contracts between the dashboard HTTP/WS server and any dashboard client (UI SDK, CLI tools, tests). Pure types + a small set of runtime-erasable type guards. Zero deps beyond `@koi/core`.

## What it defines

- **Read-models** for the four dashboard surfaces named in the v2 plan:
  - `AgentStatus` — current state of one agent (id, name, lifecycle, channels, model, parent).
  - `SessionSummary` — bounded view of a session (id, agent, turns, token totals, cost, started/ended).
  - `MetricPoint` — one timestamped numeric sample (`name`, `value`, `tags`, `timestampMs`) for charts.
  - `TraceView` — a span tree for one turn (root + nested spans, durations, errors).
- **REST envelope** `ApiResult<T>` — success/error discriminated union returning `KoiError` from `@koi/core` for failures (no stack leaks).
- **WebSocket subscription protocol**:
  - `WsSubscribe` / `WsUnsubscribe` — client→server frames keyed by topic.
  - `WsEvent` — server→client union covering each topic (`agent-status`, `session-summary`, `metric`, `trace`).
  - Type guards `isWsEvent`, `isAgentStatusEvent`, `isSessionEvent`, `isMetricEvent`, `isTraceEvent`.

## Not in scope

- Server logic, transports, routing — those live in `@koi/dashboard-api` (separate issue).
- UI components — those live in `@koi/dashboard-ui` (separate issue).
- Persistence, aggregation, or sampling — the API package decides how to project state.

## Layer

L0u. Imports `@koi/core` only. No runtime side effects; type guards are the only emitted JS.

## Versioning

Every event/payload carries a `v: 1` discriminator field so the protocol can evolve without breaking older clients. Bump the literal when fields change semantically.
