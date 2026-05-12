# @koi/dashboard-api — Dashboard HTTP API

`@koi/dashboard-api` is an L2 package that exposes Koi's runtime state over HTTP:
list agents, query sessions, fetch metrics, retrieve traces, and stream live events
via Server-Sent Events. The package ships a **headless** request handler — the
consumer wires it into `Bun.serve()` (or any web-standard runtime).

Resolves issue #1382 (Phase 3-obs-5).

---

## Why it exists

The dashboard frontend (`@koi/dashboard-client`) needs a stable HTTP contract for
discovering agents, inspecting sessions, charting metrics, and watching live
traces. v1 shipped a 4.7K-LOC API with 56 REST endpoints across orchestration,
debugging, demo, and deploy concerns — most of which are now extracted to
separate packages or deferred. v2 keeps the **observability core** (~600 LOC):
agents, sessions, metrics, traces, events, health.

```
 Browser / CLI                  Bun.serve()                    @koi/runtime
 ┌────────────┐  HTTP/SSE   ┌─────────────────────┐  inject   ┌────────────┐
 │ dashboard- │ ──────────→ │  createDashboardApi │ ←───────  │ data       │
 │ client     │             │  → fetch handler    │           │ source     │
 └────────────┘             └─────────────────────┘           └────────────┘
```

The package is **stateless and transport-pure** — it owns:
- Routing (path matching, method dispatch)
- Bearer-token auth
- Pagination + filter parsing
- SSE framing

It does **not** own:
- Storage (consumer injects a `DashboardDataSource`)
- Trace/metric collection (lives in `@koi/event-trace`, `@koi/agent-monitor`)
- Authorization / RBAC (delegate to a reverse proxy or wrap the handler)
- Rate limiting (cross-cutting; wrap the handler)

---

## Architecture

### Layer position

```
L0  @koi/core              ─ AgentId, SessionId, KoiError, Result<T,E> (types only)
L0u @koi/dashboard-types   ─ AgentStatus, SessionSummary, MetricPoint, TraceView, WsEvent
L2  @koi/dashboard-api     ─ this package (no L1 dependency)
```

Imports only from `@koi/core` and `@koi/dashboard-types`. Never imports
`@koi/engine` or peer L2 packages — adapters that bridge to `@koi/event-trace`
or `@koi/agent-monitor` live in `@koi/runtime`.

### Internal module map

```
src/
├── index.ts          ← public re-exports
├── types.ts          ← DashboardDataSource, DashboardApiConfig, query types
├── auth.ts           ← bearer token check (constant-time compare)
├── router.ts         ← regex pattern matcher, method dispatch
├── pagination.ts     ← cursor encode/decode + clamp helpers
├── query.ts          ← parse query strings into typed filters
├── handlers.ts       ← REST endpoint handlers (agents, sessions, metrics, traces, health)
├── sse.ts            ← SSE producer with batching + heartbeats
└── handler.ts        ← createDashboardApi() factory — composes the above
```

### Endpoint map

| Method | Path | Auth | Returns |
|---|---|---|---|
| `GET` | `/health` | — | `{ ok, version, capabilities[] }` |
| `GET` | `/agents` | bearer | `{ items: AgentStatus[], nextCursor? }` |
| `GET` | `/agents/:id` | bearer | `AgentStatus` or 404 |
| `POST` | `/agents/:id/terminate` | bearer | 202 or 404 |
| `GET` | `/sessions` | bearer | `{ items: SessionSummary[], nextCursor? }` |
| `GET` | `/sessions/:id` | bearer | `SessionSummary` or 404 |
| `GET` | `/metrics` | bearer | `{ points: MetricPoint[] }` |
| `GET` | `/traces` | bearer | `{ items: TraceView[], nextCursor? }` |
| `GET` | `/traces/:id` | bearer | `TraceView` or 404 |
| `GET` | `/events` | bearer | SSE stream of `WsEvent` batches |

Every JSON response is wrapped in the `ApiResult<T>` envelope from
`@koi/dashboard-types`:

```typescript
type ApiResult<T> =
  | { ok: true;  value: T }
  | { ok: false; error: KoiError };
```

### Query parameters

| Parameter | Where | Type | Default | Notes |
|---|---|---|---|---|
| `cursor` | `/agents`, `/sessions`, `/traces` | opaque base64 | — | from previous response's `nextCursor` |
| `limit` | list endpoints | number | 50 | max 200, clamped server-side |
| `state` | `/agents` | string | — | filters by `AgentStatus.state` |
| `agentId` | `/sessions`, `/traces` | AgentId | — | exact match |
| `status` | `/sessions` | string | — | filters by `SessionSummary.status` |
| `name` | `/metrics` | string | — | metric name filter |
| `since` | `/metrics`, `/traces` | number (ms) | — | filter by `timestampMs >= since` |
| `topics` | `/events` | comma-sep | all | subset of `WsTopic` |
| `logLevel` | `/events` | enum | `info` | reserved for filtered event subscription |

Cursors are **opaque to both client and API**. The data source owns cursor
encoding/decoding — different adapters may use different formats (the
`encodeCursor`/`decodeCursor` helpers shipped in this package are convenience
utilities for in-memory implementations, not a wire contract). The API
forwards `cursor` to the data source verbatim; if the cursor is malformed the
data source returns `Result.error` with code `VALIDATION`, which the API maps
to a 400 response.

### Authentication

Bearer token via `Authorization: Bearer <token>`:
- Token comes from `DashboardApiConfig.authToken`. Empty/undefined config rejects
  every request with 503 (fail closed).
- `/health` is unauthenticated (used for liveness probes).
- Token compare uses `Bun.password.verifyTimingSafe` equivalent via
  byte-by-byte XOR to prevent timing oracles.

### SSE protocol

- `GET /events` returns `Content-Type: text/event-stream`.
- Server emits one SSE message per batch (`event: batch`, `data: <json>`),
  where the JSON shape is `{ seq, timestampMs, events: WsEvent[] }`.
- Default flush interval: 100 ms; max events per batch: 500.
- Buffer overflow drops oldest events (not slowest-client disconnect — keep the
  v2 semantics simple).
- Heartbeat every 15 s as `: ping\n\n`.
- Client reconnects with `Last-Event-ID`; server replies fresh state via REST
  rather than replaying — kept stateless on purpose.

### Data source contract

```typescript
interface DashboardDataSource {
  listAgents(q: AgentListQuery): MaybeAsync<Result<Page<AgentStatus>, KoiError>>;
  getAgent(id: AgentId): MaybeAsync<Result<AgentStatus | undefined, KoiError>>;
  terminateAgent(id: AgentId): MaybeAsync<Result<boolean, KoiError>>;
  listSessions(q): MaybeAsync<Result<Page<SessionSummary>, KoiError>>;
  getSession(id): MaybeAsync<Result<SessionSummary | undefined, KoiError>>;
  listMetrics(q): MaybeAsync<Result<readonly MetricPoint[], KoiError>>;
  listTraces(q): MaybeAsync<Result<Page<TraceView>, KoiError>>;
  getTrace(id): MaybeAsync<Result<TraceView | undefined, KoiError>>;
  subscribe(cb: (event: WsEvent) => void): () => void;
}
```

`Page<T> = { items: readonly T[]; nextCursor?: string }`. The data source owns
storage, indexing, and snapshot semantics — the API package never holds state.

**Error model — structured Result, never throw.** Methods return
`Result<T, KoiError>`:

- `{ ok: true, value }` is the success payload. `value` may be `undefined`/
  `false` for not-found / no-op (those still return 200 wrapper +
  package-level 404 logic, not adapter-level errors).
- `{ ok: false, error }` carries a structured `KoiError`. The API maps
  `error.code` to a stable HTTP status (`UNAVAILABLE`→503, `TIMEOUT`→504,
  `RATE_LIMIT`→429, `PERMISSION`→403, `NOT_FOUND`→404, …) and forwards
  `retryable` / `retryAfterMs` / `context` to the client envelope.

**Adapter responsibility:** sanitize `error.message` and `error.context` before
returning. Whatever is in those fields reaches the wire verbatim — never put
tenant identifiers, ACL row text, or backend secrets there. The API strips
`cause` defensively.

**Thrown values are bugs, not failures.** If a method throws, the catch-all
returns an opaque `500 INTERNAL` to the client and logs only the request
method/path plus the Error class name. No raw message, stack, or context is
emitted to logs.

---

## API

### `createDashboardApi(config)`

```typescript
import { createDashboardApi } from "@koi/dashboard-api";

const api = createDashboardApi({
  authToken: process.env.DASHBOARD_TOKEN,
  source: makeDataSource(),
  version: "0.1.0",
});

Bun.serve({
  port: 3100,
  fetch: api.fetch,
});
```

Returns `{ fetch: (req: Request) => Promise<Response> }` — composable into any
web-standard runtime.

### `DashboardApiConfig`

```typescript
interface DashboardApiConfig {
  readonly source: DashboardDataSource;
  /** Required. Empty/undefined → fail closed (503). */
  /** Empty/undefined → 503 fail-closed on every authed endpoint. */
  readonly authToken: string | undefined;
  /** Reported on /health. Default: "unknown". */
  readonly version?: string;
  /** Reported on /health for client capability negotiation. */
  readonly capabilities?: readonly string[];
  /** Default: 50. Hard max: 200. */
  readonly defaultLimit?: number;
  /** Default: 200. */
  readonly maxLimit?: number;
  /** SSE flush interval in ms. Default: 100. */
  readonly sseFlushMs?: number;
  /** SSE max buffered events before oldest are dropped. Default: 1000. */
  readonly sseBufferLimit?: number;
}
```

---

## Examples

### Minimal mount

```typescript
import { createDashboardApi } from "@koi/dashboard-api";

const api = createDashboardApi({
  source,
  authToken: "secret",
  version: "0.1.0",
});

Bun.serve({ port: 3100, fetch: api.fetch });
```

### Subscribing to live events from a browser

```typescript
const es = new EventSource("/events?topics=agent-status,session-summary", {
  // EventSource doesn't support headers natively; either proxy + cookie, or
  // terminate auth at a reverse proxy.
});
es.addEventListener("batch", (msg) => {
  const { events } = JSON.parse(msg.data);
  for (const e of events) renderEvent(e);
});
```

### Pagination

```typescript
const first = await fetch("/agents?limit=50", {
  headers: { Authorization: `Bearer ${token}` },
});
const { value } = await first.json();
if (value.nextCursor) {
  const next = await fetch(`/agents?cursor=${value.nextCursor}`, ...);
}
```

---

## Performance properties

| Operation | Cost |
|---|---|
| Route match | O(routes) — regex per request, ~10 patterns |
| Auth check | O(token length) constant-time XOR |
| Pagination | O(1) — cursor is opaque base64 of two scalars |
| SSE fanout | O(subscribers) on each `subscribe` callback |
| SSE batch flush | O(buffered events) at flush interval |

No per-request allocations beyond the `Response` object and the parsed query.

## Security

- Fail-closed auth (no token → 503 on every endpoint except `/health`)
- Constant-time token comparison
- Errors never leak internal paths or stack traces — only `KoiError.code` +
  `message` reach the wire
- Cursor decoding validates shape; malformed input → `VALIDATION` not 500
- The handler does not enforce rate limiting — wrap externally if needed
- The handler trusts the `DashboardDataSource` to validate AgentId/SessionId
  before storage

## What was simplified vs v1

| v1 surface | LOC | v2 status |
|---|---|---|
| Orchestration views/commands (Temporal, Scheduler, TaskBoard, Harness) | ~2,500 | Removed — separate L2 packages |
| Filesystem CRUD endpoints | ~400 | Removed — out of scope |
| Demo/deploy endpoints | ~200 | Removed — separate concern |
| Debug/forge/instrumentation views | ~800 | Removed — defer |
| Custom router with optional segments | ~400 | Reduced to ~80 LOC |
| 56 REST endpoints | — | 9 essential endpoints |
| 0 auth | — | Bearer token required |
| 0 pagination | — | Cursor on all list endpoints |
