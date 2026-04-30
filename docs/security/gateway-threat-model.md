# Gateway HTTP Threat Model

Threat model for `@koi/gateway-http` (issue #1639). STRIDE-aligned analysis of the production HTTP/WebSocket ingress surface, mitigations, residual risk, and out-of-scope items.

---

## 1. System Description

`@koi/gateway-http` exposes Bun's HTTP/WebSocket server as the production ingress for `@koi/gateway`. Inbound webhook payloads are authenticated via per-channel HMAC SHA-256, deduplicated, rate-limited, audited, and dispatched as `GatewayFrame` events into the gateway pipeline.

**Trust boundary:** the public internet (or an upstream reverse proxy) on one side, the in-process `Gateway` on the other. Everything between is in scope.

**Assets protected:**
- Tenant data in flight and at rest in caches (nonce LRU, idempotency cache)
- Agent compute capacity (rate-limit fairness, maxInFlight budget)
- Audit log integrity (no message loss for accept/reject outcomes)
- Gateway availability (graceful shutdown, no split-brain replay state)

---

## 2. Threats & Mitigations (STRIDE)

### S — Spoofing

| Threat                                            | Mitigation                                                                                                          |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Forged webhook impersonating a registered channel | Per-channel HMAC SHA-256 over `v0:{ts}:{body}` with timing-safe compare. Channel secret never logged or echoed.     |
| Tenant-ID forging via URL `:account` path segment | `tenantId` MUST be derived from signed body fields — URL params are attacker-controlled within a valid signature.   |
| Channel-existence enumeration via response timing | Decoy HMAC compute runs on unknown-channel paths so 404 timing matches 401 timing.                                  |
| Source-IP spoofing for limit evasion              | `proxyTrust.mode = "trusted"` parses `X-Forwarded-For` only when peer is in the trusted-proxy allowlist.            |

### T — Tampering

| Threat                                       | Mitigation                                                                                              |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Body modification in flight                  | HMAC over raw bytes (not re-encoded JSON) detects any byte-level mutation.                              |
| Malformed JSON bombs                         | Bounded body reader caps at `maxBodyBytes` before parse; 413 returned past limit.                       |
| Audit log tampering by attacker              | Out of scope — relies on the configured `AuditSink` (NDJSON-on-disk, Nexus, etc.) for integrity.        |

### R — Repudiation

| Threat                                  | Mitigation                                                                                                                |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Disputed accept/reject decisions        | Every request emits a `gateway.request` audit entry with `clientIp`, `channel`, `tenantId?`, `outcome`, and `latencyMs`. |
| Disputed WS upgrade                     | `gateway.ws_upgrade` audit entry with same fields plus `decision` (`accepted` / `rejected:<reason>`).                     |
| Lost decisions during shutdown          | HTTP-first drain — accepted requests run to completion within `shutdownGraceMs` before lock release.                      |

### I — Information Disclosure

| Threat                                                    | Mitigation                                                                                  |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Cross-tenant nonce/idempotency cache reads                | Caches keyed by `(channel, tenantId)`; bounded LRU per tenant — no global shared state.     |
| Stack traces leaking internals on error                   | All errors funnel through `Result<T, KoiError>`; user-facing responses never include cause. |
| CORS-mediated credential leakage                          | Strict allowlists; never `*` with credentials; reflected origin only when in allowlist.     |
| Header bleed (Authorization passed back via reflection)   | Allowlisted response headers only; request headers never echoed to other origins.           |

### D — Denial of Service

| Threat                                              | Mitigation                                                                                                            |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Pre-auth flood from single IP                       | Source-IP token bucket (front-door, before HMAC compute). 429 on exhaustion.                                          |
| Single-tenant noisy neighbour                       | Per-tenant token bucket post-auth; one tenant cannot exhaust another's budget.                                        |
| Global capacity exhaustion (slow handlers)          | `maxInFlight` cap; 503 when saturated. Coupled with `shutdownGraceMs` so drain has a known ceiling.                   |
| WS handshake flood / slowloris                      | `maxPendingUpgrades`, `maxWsConnections`, `wsHandshakeTimeoutMs`, `wsIdleTimeoutSec` all enforced pre-upgrade.        |
| Cache-eviction attack (nonce LRU pressure)          | Per-tenant scoping prevents cross-tenant eviction; `nonceLruSize` per tenant + `maxTenantsPerChannel` global cap.     |
| Replay window enlargement via clock skew            | Server clock is the source of truth; `replayWindowSeconds` defaults to 300s; outside window → 401.                    |

### E — Elevation of Privilege

| Threat                                                    | Mitigation                                                                                              |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Unauthenticated request reaches `Gateway.ingest`          | Pipeline rejects pre-dispatch on any auth failure; dispatch step (#16) only reached after step #11 OK.  |
| Privileged-method bypass via verb tunneling               | Method whitelist (POST only for ingestion routes); 405 on others.                                       |
| Lock-file race causing two servers on same host           | PID lock with stale-PID reclaim — atomic write + read-back validation.                                  |

---

## 3. Out of Scope (Known Follow-Ups)

These were identified during 9 rounds of adversarial review and intentionally deferred:

1. **Cross-host singleton enforcement.** PID lock prevents same-host split-brain, but two hosts behind a shared load balancer can both run servers. Replay caches are per-process, so the same nonce could be accepted by host A and host B. Resolution requires a distributed coordinator (Nexus, etcd, Redis lock) — separate package.
2. **Durable idempotency state.** Idempotency cache is in-memory with TTL eviction. Restart loses pending reservations; cross-host retries cannot dedup. Resolution: pluggable `IdempotencyStore` backed by Redis/Nexus.
3. **WebSocket frame forwarding.** `ws-gate.ts` admits and counts WS connections, but full bidirectional frame forwarding to `Gateway.ingest` is deferred. Current scope: admission control only.
4. **Per-route fine-grained limits.** Rate limits are per-channel and per-tenant. Per-route (e.g., per-event-type) limits would require richer key derivation.
5. **Body-decompression bombs.** Server accepts only `Content-Encoding: identity`. `gzip`/`br` support is out of scope; would need decompression-bomb guards.

---

## 4. Residual Risk

After mitigations, the principal residual risks are:

- **Multi-host deployment** without a distributed lock will accept replays across hosts. Single-host or sticky-LB deployments are the supported model until follow-up #1 lands.
- **Audit-sink reliability** is the responsibility of the configured `AuditSink`; lossy sinks erode the repudiation guarantee.
- **Channel-secret rotation** requires re-registering the `ChannelRegistration`; rotation while a verification is in flight is racy by 1 request.

---

## 5. Audit Schema

Every accept/reject decision emits one of:

```ts
{ kind: "gateway.request", clientIp, channel, tenantId?, outcome, latencyMs, ... }
{ kind: "gateway.ws_upgrade", clientIp, channel, tenantId?, decision, ... }
```

`outcome` ∈ `"ok" | "rejected:auth" | "rejected:replay" | "rejected:rate" | "rejected:idempotency" | "rejected:body" | "rejected:method" | "rejected:cors" | "rejected:capacity" | "rejected:not-found"`.

---

## 6. References

- Design spec: `docs/superpowers/specs/2026-04-29-gateway-http-1639-design.md`
- Implementation plan: `docs/superpowers/plans/2026-04-29-gateway-http-1639.md`
- L2 docs: `docs/L2/gateway-http.md`
- Issue: [#1639](https://github.com/koi-ai/koi/issues/1639)
