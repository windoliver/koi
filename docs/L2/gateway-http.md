# @koi/gateway-http — Production HTTP/WS Gateway

Hardened HTTP/WebSocket ingress for `@koi/gateway`. Authenticates webhook payloads via per-channel HMAC SHA-256, blocks replay attacks, enforces strict CORS, applies layered rate limits, and emits structured audit entries — then dispatches verified frames into the gateway pipeline.

---

## Why It Exists

`@koi/gateway-webhook` covers single-tenant dev/test ingestion. Production deployments need:

- **Per-channel cryptographic auth** (HMAC v0 family) with timing-safe verification
- **Per-tenant isolation** for nonce, idempotency, and rate-limit state — one noisy tenant cannot evict another's replay cache
- **Layered defence**: source-IP front-door (pre-auth) + tenant bucket (post-auth) + max-in-flight backpressure
- **Strict CORS** with explicit allowlists — never `*`, no credentials reflection
- **Structured audit trail** for every accept/reject decision
- **Graceful shutdown** that drains HTTP, then WS, within a shared grace budget
- **Singleton enforcement** via PID lock (same-host) to prevent split-brain replay caches

This is the production-mode counterpart to `@koi/gateway-webhook`.

---

## Architecture

L2 feature package — depends on `@koi/core` (L0) and `@koi/gateway-types` (L0u). Wires into a pre-built `Gateway` (the contract from `@koi/gateway-types`).

```
┌──────────────────────────────────────────────────────────┐
│  @koi/gateway-http  (L2)                                 │
│                                                          │
│  server.ts        ← Bun.serve factory + lifecycle        │
│  pipeline.ts      ← 16-step request flow                 │
│  ws-gate.ts       ← pre-upgrade admission control        │
│  shutdown.ts      ← HTTP-first drain orchestrator        │
│  hmac.ts          ← Slack-format `v0:{ts}:{body}` HMAC   │
│  replay.ts        ← timestamp + nonce verifier           │
│  nonce.ts         ← per-tenant nonce LRU                 │
│  idempotency.ts   ← per-tenant pending/completed cache   │
│  rate-limit.ts    ← source/tenant token-bucket store     │
│  source-id.ts     ← trusted-proxy aware client IP        │
│  cors.ts          ← strict allowlist preflight + headers │
│  routing.ts       ← URL pattern → channel + params       │
│  channel.ts       ← channel registry with collision check│
│  audit.ts         ← gateway.request / gateway.ws_upgrade │
│  lock.ts          ← PID lock with stale reclaim          │
│  parse.ts         ← bounded body reader + JSON parse     │
│  token-bucket.ts  ← refilling token bucket               │
│  lru.ts           ← bounded LRU map                      │
└──────────────────────────────────────────────────────────┘
                       │
        ┌──────────────┴──────────────┐
        ▼                             ▼
┌──────────────────┐         ┌────────────────────┐
│  @koi/core (L0)  │         │ @koi/gateway-types │
│                  │         │      (L0u)         │
│  Result, Error,  │         │  Gateway,          │
│  AuditSink,      │         │  GatewayFrame,     │
│  AuditEntry      │         │  Session,          │
│                  │         │  RoutingContext    │
└──────────────────┘         └────────────────────┘
```

---

## Quick Start

```typescript
import { createGatewayServer, DEFAULT_GATEWAY_HTTP_CONFIG } from "@koi/gateway-http";
import { createGateway } from "@koi/gateway";

const gateway = createGateway(/* ... */);

const server = createGatewayServer({
  config: DEFAULT_GATEWAY_HTTP_CONFIG,
  gateway,
  channels: [
    {
      id: "slack",
      secret: process.env.SLACK_SIGNING_SECRET ?? "",
      replayProtection: "nonce",
      authenticate: slackAuthenticator,
      extractDeliveryId: (_req, payload) =>
        (payload as { event_id?: string }).event_id,
    },
  ],
  audit: ndjsonAuditSink,
});

await server.start();
// POST /channels/slack → HMAC verified → dispatched as GatewayFrame
```

---

## The 16-Step Pipeline

Every inbound request flows through a numbered, audit-traced pipeline. Failure at any step returns a typed response and emits a `gateway.request` audit entry.

| #  | Step                              | Pre-auth | Outcome                                         |
| -- | --------------------------------- | :------: | ----------------------------------------------- |
| 1  | Source-IP resolution (proxy-aware)|    ✓     | `clientIp` for limits + audit                   |
| 2  | Source-IP rate limit              |    ✓     | 429 if bucket empty                             |
| 3  | URL routing                       |    ✓     | match channel or 404                            |
| 4  | Channel lookup                    |    ✓     | unknown channel → 404                           |
| 5  | CORS preflight (OPTIONS)          |    ✓     | early return for OPTIONS                        |
| 6  | Method check                      |    ✓     | non-POST → 405                                  |
| 7  | Bounded body read                 |    ✓     | `maxBodyBytes` exceeded → 413                   |
| 8  | Body parse                        |    ✓     | `INVALID_BODY` → 400                            |
| 9  | HMAC verify (constant-time)       |    ✓     | mismatch → 401 (with decoy compute on miss)     |
| 10 | Replay window check               |    ✓     | timestamp drift → 401                           |
| 11 | Auth → tenantId resolution        |          | rejected → 401 / 403                            |
| 12 | Per-tenant nonce check            |          | seen → 409                                      |
| 13 | Per-tenant rate limit             |          | bucket empty → 429                              |
| 14 | Idempotency reserve (pending)     |          | already-completed → cached response             |
| 15 | maxInFlight backpressure          |          | saturated → 503                                 |
| 16 | Dispatch + cache outcome          |          | dispatched → `gateway.request` ok               |

A **decoy HMAC compute** runs even on channel-secret-not-found paths to close the channel-existence timing oracle.

---

## Key Types

| Type                   | Purpose                                                       |
| ---------------------- | ------------------------------------------------------------- |
| `GatewayHttpConfig`    | bind, body limits, CORS, proxy trust, shutdown grace, lock    |
| `ChannelRegistration`  | id, secret, replay mode, authenticator, parseBody, rateLimit  |
| `ChannelAuthenticator` | `(req, rawBody, payload, secret) => Result<AuthOutcome>`      |
| `AuthOutcome`          | `agentId`, `tenantId` (signed-fields only), routing, metadata |
| `GatewayServer`        | `start`, `stop`, `port`                                       |
| `ReplayProtectionMode` | `"nonce"` (default) or `"timestamp-only"`                     |
| `ProxyTrustConfig`     | `none` or `trusted` with proxy CIDR/IP allowlist              |

---

## Security Properties

**HMAC verification.** SHA-256 over Slack-format `v0:{ts}:{body}`, compared with `crypto.timingSafeEqual`. Decoy compute on missing channel keeps response timing identical to a real-channel mismatch.

**Replay protection.** Timestamp must fall within `replayWindowSeconds` (default 300). In `nonce` mode, nonces are tracked in a per-tenant bounded LRU; replays return 409.

**Per-tenant isolation.** Nonce caches, idempotency caches, and rate-limit buckets are keyed by `(channel, tenantId)`. `tenantId` MUST come from signed body fields — URL `:account` segments are attacker-controlled within a valid signature and are rejected as the binding source.

**Idempotency.** Pre-dispatch reservation: `pending → completed | cleared`. Concurrent retries with the same delivery ID either receive the cached response or are rejected as already in-flight.

**Layered rate limits.**
- *Source-IP* (pre-auth, optional) — front-door defence. Can be set to `"disabled-acknowledged"` only if upstream provides equivalent.
- *Per-tenant* (post-auth) — fair-share enforcement.
- *maxInFlight* — global concurrency cap; request 503s when saturated.

**CORS.** Strict allowlists for origins/methods/headers. Reflecting `Origin` is only honoured when the origin is in the allowlist; never `*` with credentials. Preflight (OPTIONS) short-circuits before auth.

**WebSocket admission.** Pre-upgrade gate (`ws-gate.ts`) enforces `maxPendingUpgrades`, `maxWsConnections`, and a handshake timeout. Idle connections are dropped at `wsIdleTimeoutSec`. The WS gate currently counts admitted sockets; full frame forwarding is deferred.

**Singleton enforcement.** `lock.ts` writes `${PID}` + start timestamp to `lockFilePath`. Stale-PID reclaim allows safe restart on the same host. Cross-host coordination is **out of scope** — see threat model.

**Audit trail.** Every request emits `gateway.request` with `kind`, `clientIp`, `channel`, `tenantId?`, `outcome` (`ok` / `rejected:<reason>`), `latencyMs`. WS upgrades emit `gateway.ws_upgrade`.

**Graceful shutdown.** HTTP-first drain: stop accepting → wait in-flight ≤ `shutdownGraceMs` → close WS sockets with shared remaining budget → release lock.

---

## Threat Model & Scope Boundaries

See [`docs/security/gateway-threat-model.md`](../security/gateway-threat-model.md) for the full STRIDE-aligned analysis, mitigations, and known follow-ups (cross-host singleton, durable idempotency state).

---

## Reference

- Design spec: `docs/superpowers/specs/2026-04-29-gateway-http-1639-design.md`
- Implementation plan: `docs/superpowers/plans/2026-04-29-gateway-http-1639.md`
- Issue: [#1639](https://github.com/koi-ai/koi/issues/1639)
