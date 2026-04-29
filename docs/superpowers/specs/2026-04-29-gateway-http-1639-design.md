# Gateway HTTP — Production gateway mode (issue #1639)

**Status:** Design
**Issue:** [#1639](https://github.com/windoliver/koi/issues/1639)
**Date:** 2026-04-29
**Layer:** L2 (`@koi/gateway-http`)
**Depends on (runtime):** `@koi/core` (L0), `@koi/errors` (L0u). No peer-L2 runtime dependencies — verified against `scripts/check-layers.ts` which enforces L2 → L0/L0u only.
**Depends on (interface only, no runtime import):** `Gateway` and `AuditSink` are injected through dep parameters. Their type contracts live in `@koi/core` (added by this PR as new L0 type-only modules). Both `@koi/gateway` and `@koi/middleware-audit` already implement those contracts; the L3 meta package (`@koi/runtime`) wires them together. `@koi/gateway-http` therefore never imports `@koi/gateway` or `@koi/middleware-audit` directly.
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

## Deployment Constraint: Singleton (Honest Limits)

This package is **single-instance only**. Replay nonces, rate-limit buckets, and the in-flight queue are all in-process state. Running two replicas behind a load balancer creates blocking failure modes:

- The same signed request can be replayed once per replica.
- Each replica maintains an independent rate-limit bucket — total throughput is `replicas × configured limit`.
- Audit ordering is no longer monotonic across replicas.

**The package cannot enforce singleton across hosts.** A local PID lock would only catch a second process on the same machine and would falsely advertise "enforcement" against the realistic multi-pod/multi-VM deployment model. Instead, this package treats singleton as a contract the operator must honor and surfaces it three ways:

1. **Startup advertisement.** On `start()`, the server emits a one-time audit record `kind: "gateway.singleton_advertised"` containing `{ instanceId, hostname, pid, bind }`. Operators integrating with a registry/discovery system can detect duplicate advertisements with the same logical role and alert.
2. **Same-host PID lock.** `start()` still acquires a same-host PID lock at `${KOI_RUNTIME_DIR}/gateway-http.lock` (default `/tmp/koi/gateway-http.lock`) via `O_EXCL`. Stale locks (dead PID) are reclaimed. This is documented as defending against accidental duplicate launches on one host **only** — not as cross-host enforcement.
3. **Documentation as the primary guarantee.** Both `docs/L2/gateway-http.md` and `docs/security/gateway-threat-model.md` state that running multiple replicas is a **blocking misconfiguration**, equivalent to disabling replay protection and rate limiting. The deployment runbook (added in this PR) instructs operators on safe rollout patterns: rolling restart with zero-overlap (`stop` old → `start` new), or explicitly opting into the unsafe multi-instance mode below.

**No multi-instance escape hatch is exposed in this PR.** Earlier drafts proposed an `allowMultipleInstances` flag for operators with external coordination, but the package does not yet expose pluggable interfaces for shared nonce, idempotency, or rate-limit stores — turning the flag on would silently degrade replay protection and rate limiting without giving operators anywhere to plug in real coordination. The flag has therefore been removed. When the distributed-coordination follow-up adds `NonceStore`, `IdempotencyStore`, and `RateLimitStore` interfaces, that PR will reintroduce the multi-instance configuration alongside them.

**Distributed coordination is explicitly out of scope for this PR.** Until that follow-up lands, multi-instance deployment is unsupported and is structurally prevented for same-host duplicates by the PID lock; for multi-host duplicates, prevention relies on the operator's deployment system (Kubernetes `replicas: 1`, a leader-elected DaemonSet, etc.) and on the singleton-advertisement audit signal.

## Architecture

### Package Layout

```
packages/net/gateway-http/
├── package.json                       # deps: @koi/core, @koi/errors only (L0/L0u)
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

L2. Runtime deps are L0 + L0u only (`@koi/core`, `@koi/errors`) — verified against `scripts/check-layers.ts:528+` which enforces L2 packages may only depend on L0/L0u at runtime.

The two cross-package contracts the gateway needs (`Gateway` for WS protocol delegation, `AuditSink` for structured audit events) are added to `@koi/core` as new type-only modules in this PR:

- `@koi/core/gateway-contract` — defines `Gateway`, `WsAdapter`, `pauseIngress`, `forceClose`, `activeConnections`, `ingest`. The existing `@koi/gateway` package implements this contract; this PR adds an `implements` declaration to `@koi/gateway` (no behavior change). Adding a new type-only export to `@koi/core` is layer-legal — L0 already contains contracts.
- `@koi/core/audit-sink-contract` — defines `AuditSink`. The existing `@koi/middleware-audit` already exports a structurally identical `AuditSink`; this PR moves the type to `@koi/core` and updates `@koi/middleware-audit` to re-export it (no behavior change for that package's consumers).

`@koi/gateway-http` consumes both contracts purely as injected dep parameters. The L3 meta package `@koi/runtime` is responsible for instantiating `@koi/gateway` and `@koi/middleware-audit` and passing them into `createGatewayServer`. `@koi/gateway-http` never imports `@koi/gateway` or `@koi/middleware-audit` directly. Both `auditSink` and `gateway` are runtime-required (the gateway is no longer optional, since the WS upgrade path needs it; for HTTP-only deployments, callers pass a no-op `WsAdapter` whose `pauseIngress`/`activeConnections` are trivially satisfied).

### Public API

```typescript
// types.ts (excerpt) — all imports are from @koi/core (L0) only
import type { KoiError, Result, RoutingContext, SessionId } from "@koi/core";
import type { Gateway } from "@koi/core/gateway-contract";
import type { AuditSink } from "@koi/core/audit-sink-contract";

export interface GatewayHttpConfig {
  readonly bind: string;                    // "127.0.0.1:8000"
  readonly maxBodyBytes: number;            // default 1_048_576
  readonly maxInFlight: number;             // default 256
  readonly replayWindowSeconds: number;     // default 300
  readonly nonceLruSize: number;            // default 10_000 per (channel, tenantId)
  readonly maxTenantsPerChannel: number;    // default 10_000 — caps per-tenant nonce slice count
  readonly idempotencyTtlSeconds: number;   // default 86_400 (24h)
  readonly idempotencyLruSize: number;      // default 5_000 per (channel, tenantId)
  readonly maxPendingUpgrades: number;      // default 64
  readonly maxWsConnections: number;        // default 1024
  readonly wsHandshakeTimeoutMs: number;    // default 5_000
  readonly wsIdleTimeoutSec: number;        // default 120
  readonly cors: CorsConfig;                // default { allowedOrigins: [] }
  readonly shutdownGraceMs: number;         // default 10_000
  readonly proxyTrust: ProxyTrustConfig;    // explicit, no default (see below)
  readonly sourceLimit: RateLimitConfig | "disabled-acknowledged"; // no default; non-loopback bind requires explicit choice
  readonly lockFilePath: string;            // default ${KOI_RUNTIME_DIR}/gateway-http.lock (same-host PID lock)
}

export type ProxyTrustConfig =
  | { readonly mode: "none" }                                    // direct exposure (rare); use socket address as source
  | { readonly mode: "trusted"; readonly trustedProxies: readonly string[] }; // CIDR list; X-Forwarded-For honored only from these


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
  readonly extractDeliveryId: (req: Request, payload: unknown) => string | undefined;
  readonly parseBody?: (rawBody: string, contentType: string | null) => Result<unknown, KoiError>;
}

export type ChannelAuthenticator = (
  req: Request,
  rawBody: string,
  payload: unknown,        // already parsed by the gateway; treat as untrusted, validate per-field
  secret: string,
) => Promise<Result<AuthOutcome, KoiError>>;

export interface AuthOutcome {
  readonly agentId: string;
  /**
   * Verified tenant identifier extracted from the signed request body or trusted headers.
   * Required. Used as the authoritative key for post-auth tenant rate-limit and
   * idempotency caching. Must NOT be derived from URL path segments alone — the URL
   * is attacker-controlled within a valid signature.
   */
  readonly tenantId: string;
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

1. **Accept** — parse URL. If the path does not match `POST /webhooks/:channel/:account?` → 404. If the path matches but the `:channel` is not registered, the request still **flows through the full pipeline** (steps 2–6) using a synthetic decoy registration: a fixed dummy secret, default rate-limit settings, and the same body-read + HMAC + replay code paths. The HMAC always fails timing-safe and the request returns 401 with the generic `unauthorized` body at step 6, identical in shape, status, and approximate latency to a registered-channel HMAC failure. Audit `rejected:auth` (unknown-channel detail recorded only in the audit log).

   This eliminates both the response-shape and the timing oracles. The cost is performing one body-read + HMAC on traffic to non-existent channels, but that work is bounded by `maxBodyBytes` and the source-IP limiter (which already throttled the request in step 4). Channel ids are not secrets per se — they appear in operator docs and webhook URLs — but suppressing easy enumeration raises the cost of recon.
2. **Backpressure** — if `inFlight >= maxInFlight`, respond 429 + `Retry-After: 1`. Audit `rejected:overflow`. Increment `inFlight` otherwise.
3. **CORS** — preflight handled here. Origin not in allowlist → 403, no `Access-Control-Allow-Origin` header.
4. **Front-door limiter (pre-auth)** — token-bucket keyed by **resolved source identity**. Source identity is derived per `proxyTrust`:
   - `mode: "trusted"` — extract the leftmost untrusted IP from `X-Forwarded-For`, accepting the header **only** when the connecting socket's address is inside one of the configured `trustedProxies` CIDRs. Otherwise discard the header and use the socket address.
   - `mode: "none"` — always use the socket address.

   `sourceLimit` has **no default — it must be set explicitly**. Startup validates the combination against the bind address:

   | bind | `proxyTrust` | `sourceLimit` | result |
   |---|---|---|---|
   | loopback (`127.0.0.1`/`::1`) | any | omitted | OK — defaults to a loopback-safe limiter |
   | non-loopback | `none` | any | `INVALID_CONFIG` — would limit the proxy IP, turning into cross-tenant DoS |
   | non-loopback | `trusted` | `RateLimitConfig` | OK — limiter keys on real source IP |
   | non-loopback | `trusted` | `"disabled-acknowledged"` | OK — operator explicitly opts out, audit emits `gateway.source_limit_disabled` |
   | non-loopback | omitted | omitted | `INVALID_CONFIG` — fail-closed; refusing to silently ship internet-facing without source protection |

   The `disabled-acknowledged` literal exists so operators who delegate source-IP throttling to a WAF/CDN must say so loudly, rather than relying on a `disabled` default that would silently leave the gateway open to cheap saturation by an attacker who can spend `maxInFlight` of body-read + HMAC work.

   When the limiter is engaged, empty bucket → 429 + `Retry-After`. Audit `rejected:rate-limit-source`. Capacity defaults to a generous 100/sec/identity so legitimate retries don't trip it.

   When the limiter is engaged, empty bucket → 429 + `Retry-After`. Audit `rejected:rate-limit-source`. Capacity defaults to a generous 100/sec/identity so legitimate retries don't trip it.
5. **Body read** — stream with size cap (`maxBodyBytes`). Oversize → 413, abort before parse. Body is kept as raw bytes; HMAC verifies pre-parse.
6. **HMAC** — base string `v0:{ts}:{body}` (Slack/Stripe-compatible), `crypto.timingSafeEqual` against header. Bad → 401 with generic body. Audit `rejected:auth`.
7. **Replay (timestamp window only, pre-auth)** — timestamp window check (`|now - ts| <= replayWindowSeconds`). Fail → 401. Audit `rejected:replay`. The nonce check is **deferred** to step 8.5 (post-auth) so it can be scoped to the verified tenant; performing nonce eviction pre-auth would let a noisy tenant churn another tenant's nonce history within the same channel registration and re-enable replay attacks against the quiet tenant.
8. **Parse body (pre-auth)** — `JSON.parse(rawBody)` (or `channel.parseBody(rawBody, contentType)` if provided). Failure → **400** `{ ok: false, code: "INVALID_BODY" }` immediately, with no adapter callback invoked. Audit `rejected:invalid-body`. Performing the canonical parse here (after HMAC has verified the bytes are authentic but before any adapter code runs) means malformed-but-signed bodies always surface as the documented deterministic 400, never as adapter-specific 401/500. Adapters receive the parsed payload in step 9 and can rely on it being well-formed.
9. **Authenticate** — `channel.authenticate(req, rawBody, payload, secret)` returns `Result<AuthOutcome, KoiError>`. The signature is widened to include the parsed payload so adapters can extract `tenantId` (e.g., Slack `team_id`, Stripe `account`) from request fields without re-parsing. Adapters MUST treat `payload` as untrusted and validate any field they read; the gateway only guarantees it is syntactically a JSON value of the expected content type. Error → 401 with generic body.
10. **Per-tenant nonce check (post-auth)** — if the channel uses `replayProtection: "nonce"`, check and insert the nonce in a **per-tenant** LRU keyed by `(channel, tenantId)`, sized `nonceLruSize` per tenant (default 10k entries). Each verified tenant gets its own bounded nonce slice, so a noisy tenant cannot evict a quieter tenant's nonces and re-enable replay against them. Duplicate nonce → 401. Audit `rejected:replay`.
11. **Tenant rate limit (post-auth)** — token-bucket keyed by `(channel, tenantId)` where `tenantId` is the **verified** identifier returned by `channel.authenticate()` in `AuthOutcome.tenantId`. The URL `:account` segment is **not** used for limiter keying, because a holder of a valid channel secret could rotate `:account` to bypass quotas or collide with another tenant's bucket. Channel adapters are responsible for extracting `tenantId` from the signed body or from headers covered by the signature (e.g., Slack `team_id`, Stripe `account` parameter). Empty bucket → 429 + `Retry-After`. Audit `rejected:rate-limit-tenant`.
12. **Resolve session** — `channel.resolveSession?(req, outcome)`. Default = `"create"` (new virtual session, matching v1 webhook).
13. **Idempotency reservation (pre-dispatch)** — replay protection (step 7) only blocks **exact** signed replays within the window. Providers also retry the same logical event with a fresh signature on network failure, stale TCP, or gateway crash. Channels supply a required `extractDeliveryId(req, payload) => string | undefined` resolver. The gateway maintains a **per-tenant** LRU sized `idempotencyLruSize` (default 5_000) per `(channel, tenantId)` — never a single channel-wide cache — keyed within each slice by `deliveryId`. Entries are state machines: `pending` (set under a per-key mutex *before* dispatch) → `completed { status, body, frameId }` (set after step 15). TTL = `idempotencyTtlSeconds` (default 86_400 = 24h, Stripe/GitHub retry window). The per-tenant slice prevents a noisy tenant from evicting a quieter tenant's completed entries before TTL expires — without it, a high-volume tenant churning the cache could cause the gateway to re-dispatch a previously-handled delivery on retry. Tenant slice count is capped by `maxTenantsPerChannel`.
    - First seen → atomically transition to `pending` (rejecting any concurrent request with the same delivery-id with **409 `{ code: "DELIVERY_IN_FLIGHT" }`**, which providers retry-after), proceed to step 13.
    - `completed` already cached → **return the cached response verbatim**, skip dispatch. Audit `idempotent-replay`.
    - Channel returns `undefined` (no provider id available) → fall through with `idempotency-disabled` audit; idempotency is best-effort only, documented per-channel.
    - **Crash-boundary semantics.** In-memory state is lost on process restart. If the server crashes between `pending` and `completed`, the next provider retry will dispatch again. This is a known limitation of the single-instance design; durable idempotency state (shared/persistent store) is part of the same distributed-coordination follow-up that gates true multi-instance operation. The threat model documents this explicitly.
14. **Dispatch** — build `GatewayFrame` (`kind: "event"`, fresh id, timestamp, payload = parsed body), call `gateway.ingest(session, frame)`. On throw: **clear the `pending` reservation** (do *not* cache the failure), respond 500 with cause-chained error so the provider's normal retry policy re-attempts. This intentionally trades a small duplicate-dispatch risk under sustained backend failure for the much worse alternative of suppressing all retries for 24 hours after a single transient blip.
15. **Respond** — 200 `{ ok: true, frameId }`; only on success transition the idempotency entry from `pending` to `completed { status: 200, body, frameId }`. 4xx client errors (`INVALID_BODY`, etc.) are also cached as `completed` because they are deterministic and retrying with the same body would produce the same 4xx; 5xx is never cached.
16. **Decrement** — `inFlight--` in `finally`.

**Idempotency caching matrix:**

| Outcome | Cache state |
|---|---|
| 200 dispatch success | `completed` for full TTL — retries return cached 200 |
| 4xx (validation, malformed body) | `completed` for full TTL — deterministic, retries useless |
| 5xx (dispatch throw, internal failure) | reservation cleared — retries can re-attempt |
| Concurrent retry while reservation `pending` | 409 `DELIVERY_IN_FLIGHT` — provider backs off |

Order rationale: cheapest URL/queue/CORS checks first; **front-door limiter** by source IP runs pre-auth to absorb forged flood without spending tenant quota; HMAC verifies raw bytes pre-parse so tampered JSON never reaches `JSON.parse`; replay before `authenticate` so adapter never sees stale or unsigned requests; **tenant limiter** runs only after successful HMAC+replay+authenticate so an attacker without a valid secret can never exhaust a real channel's bucket.

### WebSocket Upgrade

`GET /ws` is **not** an immediate `server.upgrade()`. It runs through pre-upgrade admission controls before any socket is committed:

1. **CORS** — same allowlist as HTTP routes. Non-allowed origin → 403, no upgrade.
2. **Front-door source limiter** — same `sourceLimit` token bucket used by HTTP routes; flooded source → 429 before upgrade.
3. **Concurrent upgrade cap** — `maxPendingUpgrades` (default 64) caps the number of upgrades that have been admitted but have not yet completed `@koi/gateway`'s handshake. Excess returns 503 + `Retry-After`. Audit `rejected:ws-upgrade-cap`.
4. **Concurrent WS connection cap** — `maxWsConnections` (default 1024) caps total simultaneous WS sessions. Excess returns 503. Audit `rejected:ws-connection-cap`.
5. **Handshake timeout** — once upgraded, `@koi/gateway` must complete its `connect` handshake within `wsHandshakeTimeoutMs` (default 5_000). Stalled sockets are closed and counted out of the pending-upgrade quota. This bounds slowloris-style upgrade exhaustion.
6. **Idle timeout** — Bun's per-connection idle timeout is set to `wsIdleTimeoutSec` (default 120) so abandoned sockets are reclaimed.

Only after these checks does the server call `server.upgrade(req)`. After upgrade, `@koi/gateway`'s existing handshake performs auth and sequencing. Audit records `kind: "gateway.ws_upgrade"` with the connection id and the result of each pre-upgrade check.

### Health Check

`GET /healthz` returns 200 `{ ok: true }` immediately. Bypasses all pipeline layers. Audit records the request (path, status, latency).

## Error Handling

| Failure | Class | Response | Notes |
|---|---|---|---|
| Unknown path (not under `/webhooks/...`) | expected | 404 | |
| Unknown channel under `/webhooks/...` | expected | 401 generic | Indistinguishable from bad-HMAC; closes enumeration oracle |
| Body oversize | expected | 413 | Abort before parse |
| Malformed signed body (parse failure / wrong shape / unsupported content-type) | expected | 400 `{ code: "INVALID_BODY" }` | Deterministic 4xx; no retry-loop |
| CORS rejection | expected | 403 | No ACAO header |
| Bad HMAC | expected | 401 generic | "unauthorized" |
| Replay (timestamp/nonce) | expected | 401 generic | Same body as bad HMAC |
| Rate limited (source IP, pre-auth) | expected | 429 + Retry-After | Front-door limiter |
| Rate limited (tenant, post-auth) | expected | 429 + Retry-After | Per-channel bucket |
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
- **`X-Forwarded-For` trusted only when `proxyTrust.mode = "trusted"` AND the connecting socket is in `trustedProxies`** — startup-validated. Untrusted XFF is dropped. Front-door limiter is `"disabled"` until the operator explicitly opts in with a trusted-proxy config; this prevents the common foot-gun of a single shared bucket throttling all tenants behind one proxy IP.
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
9. Unknown channel under `/webhooks/...` → 401 with identical body+timing to bad-HMAC (no enumeration). Path outside `/webhooks/...` → 404.
10. Health endpoint always 200, no auth (and 503 once draining).
11. Signed but malformed JSON body → 400 `INVALID_BODY` (not 500), audit records `rejected:invalid-body`.
12. `sourceLimit` omitted on non-loopback bind → `start()` returns `INVALID_CONFIG` (fail-closed; no listener bound). `proxyTrust.mode = "none"` on non-loopback bind also returns `INVALID_CONFIG` regardless of `sourceLimit`.
13. Provider retry — same delivery-id within TTL → second request returns the cached response verbatim, dispatch is **not** re-invoked (audit `idempotent-replay`).
14. Shutdown strand test — admit one HTTP request, call `stop()` mid-pipeline, verify the request still dispatches successfully (no `gateway.ingest()` rejection), then WS connections drain.
15. Transient 5xx retry test — first request triggers `gateway.ingest()` throw → 500; second request with same delivery-id (within TTL) re-attempts dispatch (reservation was cleared, not cached). Verifies one transient blip does not suppress 24h of retries.
16. Concurrent retry test — two simultaneous requests with the same delivery-id → first goes to `pending`, second returns 409 `DELIVERY_IN_FLIGHT`.
17. WS upgrade cap — open `maxPendingUpgrades + 1` upgrade attempts that don't complete handshake; the last returns 503 `rejected:ws-upgrade-cap`.
18. WS handshake timeout — open a TCP socket, send a valid `Upgrade` request, do not send any frames; after `wsHandshakeTimeoutMs`, the socket is closed by the gateway.
19. Tenant isolation — two requests with valid signatures but different `tenantId` values from `AuthOutcome` and the **same** `deliveryId` → both dispatch independently (no idempotency cross-contamination). Confirms the cache key includes verified `tenantId`.
20. URL `:account` rotation — same secret, same `tenantId`, but different `:account` URL segments → all share one tenant bucket (limiter keys on verified `tenantId`, not URL).
21. Per-tenant nonce isolation — flood tenant A's nonce LRU with `nonceLruSize + 1000` entries, then replay an old (still-in-window) signed request from tenant B → tenant B's nonce is still remembered and replay is rejected. Confirms eviction is bounded per-tenant.
22. Per-tenant idempotency isolation — flood tenant A's idempotency LRU with `idempotencyLruSize + 1000` completed deliveries, then a provider retry for an older completed delivery from tenant B → tenant B's cached response is returned (entry not evicted). Confirms idempotency eviction is bounded per-tenant.
23. Malformed-signed-body central handling — a channel adapter `authenticate` callback that throws if it ever sees an unparseable `rawBody`; the gateway must return a deterministic 400 `INVALID_BODY` **without** invoking that callback. Confirms parse runs centrally before adapter code.

## Graceful Shutdown

The shutdown path distinguishes two operations on `@koi/gateway`:

- **`pauseIngress()`** — stop accepting *new* frames from external WS clients (close-frame to peers; `ingest()` from internal callers continues to work).
- **`forceClose()`** — terminate WS sockets immediately.

This separation lets HTTP requests that were admitted before drain still complete `gateway.ingest()` successfully; only WS-client-originated traffic is quiesced up front.

`server.stop()` performs the following ordered actions:

1. **Mark draining.** Set internal `draining = true`. Health endpoint flips to `503 { ok: false, draining: true }` so load balancers stop sending traffic immediately.
2. **Reject new connections.** New HTTP requests return 503; new WS upgrades return 503. Already-admitted HTTP requests continue through the pipeline and are guaranteed to be able to dispatch — they are part of the drain quota.
3. **Quiesce WS ingress only.** `gateway.pauseIngress()` — existing WS sessions stop receiving new external frames (peers get a `shutdown` notification). Crucially, `gateway.ingest()` from the HTTP webhook path remains open until HTTP drain is complete; admitted HTTP requests cannot be stranded.
4. **Wait for HTTP drain.** Wait until `inFlight === 0` (all admitted HTTP requests dispatched and responded), capped at `shutdownGraceMs` (default 10s).
5. **Wait for WS drain.** After HTTP `inFlight` is zero, wait for `gateway.activeConnections() === 0` (WS clients close gracefully on receiving the shutdown notification) within the remaining grace budget.
6. **Force close.** Any time budget exceeded → `gateway.forceClose()` for remaining WS, `server.stop(true)` for any straggler HTTP connections.
7. **Stop listener.** Resolve `stop()` promise.

If `@koi/gateway` does not yet expose `pauseIngress()` / `forceClose()` / `activeConnections()`, those additions are part of this PR's scope (small surface, additive).

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
    | "rejected:rate-limit-source"
    | "rejected:rate-limit-tenant"
    | "rejected:invalid-body"
    | "idempotent-replay"
    | "idempotent-in-flight"
    | "idempotency-disabled"
    | "rejected:ws-upgrade-cap"
    | "rejected:ws-connection-cap"
    | "rejected:ws-handshake-timeout"
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

- **Bun idle/keepalive timeouts.** Defaults are likely fine; revisit if pentest scenario 7 (concurrent flood) reveals slowloris exposure.
