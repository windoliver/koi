# @koi/channel-web

**Layer:** L2 · **Contract:** `ChannelAdapter` (L0)

ChannelAdapter for browser/HTTP clients. Bun.serve-based: WebSocket push for
outbound streaming, REST POST for inbound messages. No external dependencies
— uses Bun's native HTTP/WS server.

## What it owns

- `ChannelAdapter` implementation backed by `Bun.serve()` (WS + HTTP)
- Inbound: `POST /messages` (JSON `{ senderId, content[], threadId?, metadata? }`)
- Outbound: WebSocket fan-out, **strictly scoped by thread**. Clients open
  `GET /ws?thread=<id>` to subscribe; threaded outbound messages reach only
  sockets that subscribed to that exact thread. Unscoped clients (`/ws` with
  no `?thread`) only receive outbound messages that themselves have no
  `threadId`. This prevents one authenticated client from observing another
  client's replies.
- Capability negotiation (text + images + files + buttons + threads)
- Origin allow-list + principal-resolving auth (`authenticate(ctx)` returns
  the verified `senderId`; the transport never trusts a body-supplied one)
- WebSocket auth (in priority order):
  1. `Authorization: Bearer <t>` header — preferred for non-browser clients
  2. `koi_ws` cookie — preferred for browsers (cookies are sent on the
     upgrade, never enter the URL, never appear in logs)
  3. `?token=<t>` query string — last resort. URLs leak through access logs,
     proxy logs, browser history, and crash reports. Hosts SHOULD treat any
     `?token=` value as a single-use, short-lived ticket and revoke it on
     first consumption inside `authenticate()`.
- POST `/messages` requires `Authorization: Bearer <t>` ONLY (no URL fallback)
- POST `/messages` accepts an optional `Idempotency-Key: <unique>` header.
  Repeats of the same key within 10 minutes return 202 with no re-dispatch
  so retries from browsers/proxies don't double-trigger side effects.
- CORS preflight (`OPTIONS`) handled with `Access-Control-Allow-{Origin,
  Methods, Headers}` echoed back for allow-listed origins
- Graceful disconnect drains in-flight sends before tearing the server down

## What it does NOT own

- Browser-side rendering / framework integration
- Authentication broker (token issuance) — caller supplies a `verifyToken` hook
- TLS termination — run behind a reverse proxy in production
- Persistent message storage / replay
- Rate limiting (use `@koi/middleware-call-limits` upstream)

## Dependencies

| Package | Layer | Purpose |
|---------|-------|---------|
| `@koi/core` | L0 | `ChannelAdapter`, `ContentBlock`, message types |
| `@koi/channel-base` | L0u | `createChannelAdapter()` factory + `renderBlocks()` |

## Architecture

```
HTTP POST /messages ─▶ verifyToken ─▶ parse ─▶ onPlatformEvent
                                                    │
                                                    ▼ normalize → InboundMessage

OutboundMessage ──▶ renderBlocks() ──▶ platformSend
                                            │
                                  broadcast over WS clients
```

## API

### `createWebChannel(config): ChannelAdapter`

Returns a fully wired `ChannelAdapter`. `connect()` starts the server,
`disconnect()` stops it.

### `WebChannelConfig`

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `port` | `number` | `0` (random) | TCP port to bind |
| `hostname` | `string` | `"127.0.0.1"` | Bind address |
| `path` | `string` | `"/"` | Path prefix for `messages` and `events` |
| `authenticate` | `(ctx: WebAuthContext) => WebAuthResult \| null \| Promise<...>` | open mode | Resolves the principal. Receives `{ token, threadId, request }`; returns `{ senderId }` to allow or `null` to deny (401). The host is responsible for binding `threadId` to the principal — this is where multi-tenant isolation is enforced. |
| `originAllowList` | `readonly string[] \| undefined` | undefined | CORS origin allow-list. **Required** when `authenticate` is set, unless `allowAnyOrigin: true` is also set (CSRF fail-closed default). |
| `allowAnyOrigin` | `boolean` | `false` | Opt out of the CSRF fail-closed default. Only safe when the auth scheme is not browser-ambient (e.g. tokens issued and managed entirely by your own JS — not cookies). |
| `senderId` | `string` | `"web-user"` | Default `senderId` for open mode (no `authenticate`). Production deployments MUST configure `authenticate` instead. |
| `onHandlerError` | `(err, message) => void` | undefined | Visibility hook for handler failures during async dispatch. Without this, post-202 failures are silent. Hosts needing durability MUST forward to a DLQ here. |
| `allowThreadlessAuthenticatedPost` | `boolean` | `false` | Authenticated `POST /messages` without `threadId` is rejected with `400` by default. Rationale: in authenticated mode the WS upgrade requires `?thread=`, and `send()` throws without `threadId` — so a threadless inbound has no reachable reply surface. Set `true` for explicit fire-and-forget ingestion (telemetry, webhook receivers, audit pipelines that never reply). |

### Capabilities

```typescript
{ text: true, images: true, files: true, buttons: true,
  audio: false, video: false, threads: true, supportsA2ui: false }
```

## Subscription revocation

`authenticate()` only runs at upgrade time — without an explicit revocation
hook, long-lived sockets would outlive a deauth event. The adapter exposes:

```typescript
adapter.revokeSubscriptions((s) => s.senderId === "alice"); // closes Alice's sockets with code 1008
adapter.revokeSubscriptions((s) => s.threadId === "team-x"); // closes everyone in team-x
```

Hosts MUST call this whenever an entitlement changes (logout, token revoked,
role downgrade, removed from thread). The predicate receives the same
`{ senderId, threadId }` returned by `authenticate()` at upgrade time.

## Security

- **Fail-closed by default**: `createWebChannel` throws at construction if
  `authenticate` is omitted unless the caller explicitly sets
  `allowUnauthenticated: true`. This prevents accidentally deploying an open
  agent endpoint to production.
- **No silent message drops**: `POST /messages` returns `503 No handler
  registered` when no consumer is attached, instead of acknowledging with
  202 and discarding the message.
- 401 on missing/invalid bearer token, OR when `authenticate(ctx)` returns
  `null` for the requested thread — host is responsible for binding subscriptions
  and inbound messages to the authenticated principal
- 403 on origin not in allow-list (if set)
- 413 on payloads > 1 MB (Content-Length is checked **before** the body is buffered)
- The transport never trusts `senderId` from the request body — it always uses
  the value returned by `authenticate()` (or `config.senderId` in open mode)
- Never echoes back stack traces or server-side paths

### Limitation: ingress acknowledgement is fire-and-forget

Once the `202` is returned, message handlers run asynchronously through the
shared `@koi/channel-base` dispatch chain (`Promise.allSettled`). Handler
failures are reported via the channel-base `onHandlerError` hook, NOT
surfaced as a non-2xx HTTP response. If you need durable retry-on-failure
semantics, queue messages externally before they reach this endpoint.
