# Gateway HTTP — Production gateway mode (issue #1639)

**Status:** Design
**Issue:** [#1639](https://github.com/windoliver/koi/issues/1639)
**Date:** 2026-04-29
**Layer:** L2 (`@koi/gateway-http`)
**Depends on:** `@koi/core` (L0), `@koi/errors` (L0u), `@koi/gateway` (L2 peer for WS protocol), `@koi/middleware-audit` (types only, optional)
**Blocks:** channel adapters #1362, #1363, #1371
**Pairs with:** `@koi/middleware-audit` (#1627, closed)

## Summary

A new L2 package `@koi/gateway-http` that runs a single `Bun.serve` listener providing:

- HTTP webhook ingestion at `POST /webhooks/:channel/:account?` with mandatory HMAC SHA-256 auth, replay protection, per-route token-bucket rate limits, strict CORS, and bounded backpressure (429 on overflow).
- WebSocket upgrade at `GET /ws` that delegates to the existing `@koi/gateway` handshake/protocol.
- Health endpoint at `GET /healthz` (no auth).
- Structured audit logging via the existing `AuditSink` interface from `@koi/middleware-audit`.
- Graceful shutdown that drains in-flight requests within a configured grace period.

TLS termination is **out of scope** — operators run behind a reverse proxy.

## Goals

- Provide one shared, security-reviewed HTTP/WS surface so channel adapters (Slack, Discord, Telegram, email, webhooks) do not each ship their own server.
- Match v1 webhook semantics (`archive/v1/packages/net/gateway-webhook`) and v1 Slack signature verification (`archive/v1/packages/net/channel-slack/verify-signature.ts`).
- Make every security primitive independently unit-testable.
- Single-instance scope; multi-instance scaling deferred.

## Non-Goals

- TLS termination (deferred to reverse proxy).
- Persistent storage of channel secrets, rate-limit buckets, or nonces (all in-memory).
- Distributed/multi-instance rate limiting or replay protection.
- Channel adapter implementations (separate L2 packages).
- New interposition layer parallel to `@koi/middleware` (anti-leak rule).

## Architecture

### Package Layout

```
packages/net/gateway-http/
├── package.json                       # name: @koi/gateway-http, deps below
├── tsconfig.json
├── tsup.config.ts
└── src/
    ├── server.ts                      # createGatewayServer() factory
    ├── pipeline.ts                    # composes per-request layers
    ├── hmac.ts                        # HMAC-SHA256 verify, timing-safe
    ├── replay.ts                      # nonce LRU + timestamp window
    ├── rate-limit.ts                  # token-bucket per (channel, account)
    ├── cors.ts                        # strict-by-default allowlist
    ├── routing.ts                     # URL → ChannelHandler resolution
    ├── channel.ts                     # ChannelRegistration + register()
    ├── audit.ts                       # GatewayRequestEvent shapes
    ├── ws-upgrade.ts                  # delegates to @koi/gateway
    ├── shutdown.ts                    # drain logic
    ├── types.ts                       # public types + DEFAULT_GATEWAY_HTTP_CONFIG
    ├── index.ts                       # re-exports
    └── __tests__/
        ├── server.e2e.test.ts
        ├── pentest.test.ts
        ├── shutdown.test.ts
        ├── audit-integration.test.ts
        └── ws-upgrade.test.ts
```

Per-module unit tests are colocated (`hmac.test.ts` next to `hmac.ts`) per CLAUDE.md.

### Layer Position

L2. Imports L0 (`@koi/core`, `@koi/errors`) and a peer L2 `@koi/gateway` for the WS protocol core. The peer-L2 dependency must be reviewed against `scripts/layers.ts` during planning. If layer-check forbids peer-L2 imports, the WS protocol core is extracted to a thin L0u package (e.g., `@koi/ws-protocol`) and both `@koi/gateway` and `@koi/gateway-http` consume it. This decision is deferred to plan-phase verification.

`@koi/middleware-audit` provides the `AuditSink` *type* only. The runtime dependency is optional — if no sink is supplied the gateway no-ops audit calls.

### Public API

```typescript
// types.ts (excerpt)
import type { KoiError, Result, RoutingContext, SessionId } from "@koi/core";
import type { Gateway } from "@koi/gateway";
import type { AuditSink } from "@koi/middleware-audit";

export interface GatewayHttpConfig {
  readonly bind: string;                    // "127.0.0.1:8000"
  readonly maxBodyBytes: number;            // default 1_048_576
  readonly maxInFlight: number;             // default 256
  readonly replayWindowSeconds: number;     // default 300
  readonly nonceLruSize: number;            // default 10_000 per channel
  readonly cors: CorsConfig;                // default { allowedOrigins: [] }
  readonly shutdownGraceMs: number;         // default 10_000
  readonly trustProxy: boolean;             // default false (X-Forwarded-For)
}

export interface CorsConfig {
  readonly allowedOrigins: readonly string[]; // exact match or "*" forbidden by default
  readonly allowedMethods: readonly string[]; // default ["POST"]
  readonly allowedHeaders: readonly string[];
  readonly maxAgeSeconds: number;             // default 600
}

export interface RateLimitConfig {
  readonly capacity: number;          // tokens
  readonly refillPerSec: number;
}

export type ReplayProtectionMode = "nonce" | "timestamp-only";

export interface ChannelRegistration {
  readonly id: string;
  readonly secret: string;
  readonly replayProtection: ReplayProtectionMode;
  readonly rateLimit?: RateLimitConfig;
  readonly authenticate: ChannelAuthenticator;
  readonly resolveSession?: SessionResolver;
}

export type ChannelAuthenticator = (
  req: Request,
  rawBody: string,
  secret: string,
) => Promise<Result<AuthOutcome, KoiError>>;

export interface AuthOutcome {
  readonly agentId: string;
  readonly routing?: RoutingContext;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export type SessionResolver = (
  req: Request,
  outcome: AuthOutcome,
) => Promise<SessionId | "create">;

export interface GatewayServer {
  readonly start: () => Promise<void>;
  readonly stop: () => Promise<void>;
  readonly registerChannel: (reg: ChannelRegistration) => Result<void, KoiError>;
  readonly port: () => number;
}

export interface GatewayHttpDeps {
  readonly gateway: Gateway;
  readonly auditSink?: AuditSink;
  readonly clock?: () => number;
}

export function createGatewayServer(
  config: Partial<GatewayHttpConfig>,
  deps: GatewayHttpDeps,
): GatewayServer;

export const DEFAULT_GATEWAY_HTTP_CONFIG: GatewayHttpConfig;
```

All interface properties are `readonly`. Expected failures (registration conflict, bad config) return `Result<T, KoiError>`. Unexpected failures (bun crash, dispatch throw) propagate as `Error` with `cause`.

### Routes

| Route | Auth | Notes |
|---|---|---|
| `POST /webhooks/:channel/:account?` | HMAC required | Ingestion |
| `OPTIONS /webhooks/*` | None | CORS preflight |
| `GET /ws` | Delegated to `@koi/gateway` handshake | WS upgrade |
| `GET /healthz` | None | Always 200 if listener up |
| _anything else_ | n/a | 404 |

## Request Pipeline

For `POST /webhooks/:channel/:account?`:

1. **Accept** — parse URL, extract `channel` and optional `account`. Unknown channel → 404 (no info leak about whether HMAC would have run).
2. **Backpressure** — if `inFlight >= maxInFlight`, respond 429 + `Retry-After: 1`. Audit `rejected:overflow`. Increment `inFlight` otherwise.
3. **CORS** — preflight handled here. Origin not in allowlist → 403, no `Access-Control-Allow-Origin` header.
4. **Rate limit** — token-bucket keyed by `(channel, account ?? "_")`. Empty bucket → 429 + `Retry-After: ceil(1/refillPerSec)`. Audit `rejected:rate-limit`. Performed before body read so a flooded source cannot waste ingress bandwidth.
5. **Body read** — stream with size cap (`maxBodyBytes`). Oversize → 413, abort before parse. Body is kept as raw bytes; HMAC verifies pre-parse.
6. **HMAC** — base string `v0:{ts}:{body}` (Slack/Stripe-compatible), `crypto.timingSafeEqual` against header. Bad → 401 with generic body. Audit `rejected:auth`.
7. **Replay** — timestamp window check (`|now - ts| <= replayWindowSeconds`). If channel uses `nonce` mode, check nonce LRU and insert. Fail → 401. Audit `rejected:replay`.
8. **Authenticate** — `channel.authenticate(req, rawBody, secret)` returns `Result<AuthOutcome, KoiError>`. Error → 401 with generic body.
9. **Resolve session** — `channel.resolveSession?(req, outcome)`. Default = `"create"` (new virtual session, matching v1 webhook).
10. **Dispatch** — build `GatewayFrame` (`kind: "event"`, fresh id, timestamp, payload = parsed JSON), call `gateway.ingest(session, frame)`. Throw → 500 with cause-chained error.
11. **Respond** — 200 `{ ok: true, frameId }`. Audit `ok`.
12. **Decrement** — `inFlight--` in `finally`.

Order rationale: cheapest URL/queue/CORS checks first; rate-limit before body read so flooded sources cannot waste ingress bandwidth; HMAC verifies raw bytes pre-parse so tampered JSON never reaches `JSON.parse`; replay before `authenticate` so adapter never sees stale or unsigned requests.

### WebSocket Upgrade

`GET /ws` calls `server.upgrade(req)`. On upgrade, the socket is handed to `@koi/gateway`'s existing handshake which performs its own auth and sequencing. Audit records `kind: "gateway.ws_upgrade"` with the connection id.

### Health Check

`GET /healthz` returns 200 `{ ok: true }` immediately. Bypasses all pipeline layers. Audit records the request (path, status, latency).

## Error Handling

| Failure | Class | Response | Notes |
|---|---|---|---|
| Unknown channel/path | expected | 404 (no body) | Don't reveal HMAC presence |
| Body oversize | expected | 413 | Abort before parse |
| CORS rejection | expected | 403 | No ACAO header |
| Bad HMAC | expected | 401 generic | "unauthorized" |
| Replay (timestamp/nonce) | expected | 401 generic | Same body as bad HMAC |
| Rate limited | expected | 429 + Retry-After | |
| Backpressure overflow | expected | 429 + Retry-After: 1 | |
| Channel registration conflict | expected | `Result.err({ code: "CONFLICT" })` | Caller-side failure |
| Dispatch throw | unexpected | 500 | `throw new Error(..., { cause })` |
| Bun.serve listen failure | unexpected | propagates | Caller decides |

All authentication-class failures (HMAC, replay, channel.authenticate) return identical bodies — no oracle. Detail goes to the audit log only.

## Security

### Built-in Defenses

- **Timing-safe HMAC comparison** via `crypto.timingSafeEqual`.
- **Nonce LRU bounded** (default 10k entries per channel) — no unbounded memory.
- **Body size cap before parse** — no JSON-bomb amplification.
- **Body verified before parse** — signature covers raw bytes; tampered JSON cannot reach `JSON.parse`.
- **Per-channel secret isolation** — registration map keyed by channel id; one channel's compromise does not affect others.
- **CORS strict by default** — empty allowlist denies all cross-origin; wildcard `*` rejected at config validation.
- **`X-Forwarded-For` trusted only when `trustProxy: true`** — default false. Otherwise socket address is recorded.
- **Generic error bodies** — no reflection of attacker-controlled values, no stack traces.
- **Health endpoint is the only auth-bypass route** — every other route requires HMAC.

### Threat Model

A separate document at `docs/security/gateway-threat-model.md` will cover STRIDE per route, replay scenarios, rate-limit bypass via parallel channel ids, HMAC timing oracles, body-size DoS, slowloris (handled by Bun's built-in idle timeout), session hijack via leaked secret, and out-of-scope concerns (audit log tampering — that's the sink's responsibility).

The threat model is a **merge gate**: PR cannot merge until reviewed.

### Pentest Test Suite

`src/__tests__/pentest.test.ts` exercises the following scenarios programmatically (not a real engagement):

1. Replay valid request within window with nonce mode → reject.
2. Replay valid request after window → reject.
3. Tampered body, valid old signature → reject.
4. Bit-flipped signature → reject (timing-safe).
5. Origin not in allowlist → 403.
6. Body > `maxBodyBytes` → 413, no parse attempted.
7. 1000 concurrent requests with `maxInFlight: 256` → 256 succeed, rest 429.
8. Registration of duplicate channel id → `Result.err`.
9. Unknown channel → 404.
10. Health endpoint always 200, no auth.

## Graceful Shutdown

`server.stop()` performs:

1. Stop accepting new connections (`server.stop(false)` — Bun keeps existing).
2. Wait for `inFlight` to reach 0, capped at `shutdownGraceMs`.
3. Force-close remaining via `server.stop(true)` if grace expires.
4. Close all WS connections via `@koi/gateway.shutdown()`.
5. Resolve `stop()` promise.

SIGTERM handling is the operator's responsibility (e.g., `process.on("SIGTERM", () => server.stop())`); the package does not install signal handlers itself.

## Audit Integration

Audit events use the `AuditSink` interface from `@koi/middleware-audit` (no runtime coupling — sink is `optional?`). Event shape:

```typescript
interface GatewayRequestEvent {
  readonly schema_version: 1;
  readonly kind: "gateway.request" | "gateway.ws_upgrade";
  readonly timestamp: number;
  readonly channel?: string;
  readonly path: string;
  readonly method: string;
  readonly status: number;
  readonly latencyMs: number;
  readonly authResult:
    | "ok"
    | "rejected:auth"
    | "rejected:replay"
    | "rejected:overflow"
    | "rejected:rate-limit"
    | "skipped";
  readonly sessionId?: SessionId;
  readonly remoteAddr?: string;
}
```

Sink invocations are fire-and-forget (do not block request response). Sink errors are caught and counted via a metric; they never propagate.

## Testing

### Layout

- Per-module unit tests colocated: `hmac.test.ts` next to `hmac.ts`, etc.
- Integration tests in `src/__tests__/`.
- All tests use `bun:test`. Mocks via `mock()` and `spyOn()`. No external mock libraries.

### Coverage Targets

- Security primitives (`hmac`, `replay`, `rate-limit`, `cors`): ≥ 95% — these are the attack surface.
- Pipeline composition: ≥ 90%.
- Server bootstrap/shutdown: ≥ 80%.
- Repository minimum (CLAUDE.md): 80%.

### Determinism

- `clock` dep injection allows tests to advance virtual time for window/replay/rate-limit edges.
- E2E tests use ephemeral ports (`port: 0`) and read the bound port via `server.port()`.

### Acceptance Criteria Mapping

| Criterion (issue #1639) | Verified by |
|---|---|
| HTTP server starts on configurable bind | `server.e2e.test.ts` |
| Channel adapter registration interface | `pipeline.test.ts`, `server.e2e.test.ts` |
| HMAC mandatory on non-health | `pentest.test.ts` |
| Replay protection (nonce + timestamp) | `replay.test.ts`, `pentest.test.ts` |
| CORS strict-by-default | `cors.test.ts`, `pentest.test.ts` |
| Per-route rate limits | `rate-limit.test.ts`, `pentest.test.ts` |
| Health endpoint without auth | `server.e2e.test.ts` |
| Audit log records every request | `audit-integration.test.ts` |
| Threat model document reviewed | `docs/security/gateway-threat-model.md` (merge gate) |
| Pentest tests pass | `__tests__/pentest.test.ts` |
| Documented in `docs/L2/gateway-http.md` | doc-gate CI check |

## Golden Query Coverage

CLAUDE.md requires every new L2 to be wired into `@koi/runtime` with golden coverage. Plan:

1. Add `@koi/gateway-http` as a workspace dep in `packages/meta/runtime/package.json` and `tsconfig.json`.
2. Add two standalone golden queries to `packages/meta/runtime/src/__tests__/golden-replay.test.ts`:
   - `gateway-http:webhook-roundtrip` — register a mock channel, POST a signed body, expect 200 + dispatched frame on the gateway mock.
   - `gateway-http:replay-rejected` — same body twice with `nonce` mode, second is rejected.
3. No LLM cassette is needed — these are pure protocol tests with no model in loop.
4. CI checks `check:orphans` and `check:golden-queries` will pass.

## v1 Reference Mapping

| v1 source | v2 destination |
|---|---|
| `archive/v1/packages/net/gateway-webhook/src/webhook.ts` | `src/server.ts` + `src/pipeline.ts` (rewrite with HMAC + replay + rate-limit + audit) |
| `archive/v1/packages/net/gateway-webhook/src/http-helpers.ts` | inlined where used (path matching, body parsing) |
| `archive/v1/packages/net/channel-slack/src/verify-signature.ts` | `src/hmac.ts` (generalized) + `src/replay.ts` (timestamp window) |

The existing v2 `@koi/gateway` package handles WS protocol and is consumed unchanged.

## Out of Scope (Follow-ups)

- TLS termination (`Bun.serve({ tls })`).
- Multi-instance rate limiting / replay (Redis/SQLite-backed stores).
- Persistent channel secret storage with rotation.
- Per-IP rate limiting (currently per-channel only).
- Tracing/metrics exporters (audit log is sufficient for v2 phase 3).
- Channel adapter packages — separate L2s, blocked by this issue.

## Open Questions Deferred to Plan Phase

- **Layer-check verdict on peer L2 import.** If `scripts/layers.ts` forbids `@koi/gateway-http → @koi/gateway`, extract a tiny L0u `@koi/ws-protocol` used by both. Verify in plan step 1.
- **Bun idle/keepalive timeouts.** Defaults are likely fine; revisit if pentest scenario 7 (concurrent flood) reveals slowloris exposure.
