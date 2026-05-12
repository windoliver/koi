# @koi/dashboard-ui — Dashboard SPA

`@koi/dashboard-ui` is an L2 package that ships the React 19 + Vite single-page
application served by the Koi dashboard. It consumes `@koi/dashboard-client`
(L0u SDK) to fetch HTTP snapshots and subscribe to SSE event streams from
`@koi/dashboard-api`, and renders a real-time fleet view: agents, sessions,
metrics, and traces.

Resolves issue #1383.

---

## Why it exists

The dashboard server (`@koi/dashboard-api`) exposes a typed HTTP+SSE contract
over the runtime's observability surface. The CLI ships a binary (`koi
dashboard`) that serves this UI behind cookie-bearer auth so operators can
inspect agent fleets without writing a custom frontend. Keeping the SPA as an
isolated L2 package means it can be rebuilt, replaced, or skipped (other UIs
can target the same SDK) without touching the server.

```
 Browser
 ┌─────────────────────────┐
 │ @koi/dashboard-ui (SPA) │   React 19 + Vite, served as static assets
 │   ↓ uses                │
 │ @koi/dashboard-client   │   Typed HTTP + SSE SDK (L0u)
 │   ↓ HTTP/SSE            │
 │ @koi/dashboard-api      │   L2 server, mounted on Bun.serve()
 │   ↓ injected            │
 │ DashboardDataSource     │   Provided by @koi/runtime
 └─────────────────────────┘
```

---

## What it renders

| Surface         | Source                                            |
|-----------------|---------------------------------------------------|
| Agent fleet     | `client.listAgents()` (paginated, drained)        |
| Session list    | `client.listSessions()` (paginated, drained)      |
| Metrics chart   | `client.getMetrics()` per selected session        |
| Trace viewer    | `client.getTrace()` for the latest agent turn     |
| Live updates    | `client.subscribe()` over SSE, monotonic-merged   |

The reducer (`src/lib/state.ts`) holds a discriminated `DashboardEvent` union
and enforces monotonic-merge invariants (no stale agent state overwriting a
newer one, no out-of-order trace pointers, etc.). Snapshot fetches and the
live SSE stream are reconciled by buffering events received before the
snapshot lands and replaying them after the initial state is applied.

---

## Public API

The package is the application itself; consumers import nothing from it. The
build artifact is a static asset bundle, mounted by `@koi/dashboard-api` (or
any static server).

The CLI command (`koi dashboard`) starts the API server and serves the
prebuilt bundle from `dist/` on the same origin so SSE and bearer-cookie auth
share the host.

---

## Auth

The browser never sees a bearer token. The dashboard API issues an HTTP-only
session cookie on login; `dashboard-client` is configured with
`credentials: "include"` and forwards the cookie on every request. SSE
inherits the same credential.

---

## Tests

Bun-native integration tests live in `test/integration.test.ts` and stand up
a `Bun.serve()` instance wired to the real `@koi/dashboard-api` with a
controllable `DashboardDataSource` fixture (`test/fixture-source.ts`,
`test/fixture-server.ts`). Coverage includes:

- Auth: 401 surfaces as `AUTH_REQUIRED`
- Pagination: cursor drains across multiple pages
- Snapshot failure surfaces a typed error and clears the live-event buffer
- Session metric fetch filters by `sessionId` tag and time range, fails-closed
  on partial errors
- `getMetrics` fan-out: multi-name queries merge newest-first under the
  caller's `limit`
- SSE round-trip and orphan-metric drain on `session.summary` arrival
- Multi-session monotonic `latestTurnByAgentId` invariants

Run with `bun run --cwd packages/ui/dashboard-ui test`.
