# `@koi/nexus-delegation` — Design Spec

**Issue:** #1473 (v2 Phase 3-gov-6: spawn lifecycle — per-child Nexus API key grant + revoke integration)  
**Date:** 2026-04-27  
**Status:** Approved

---

## 1. Context

When a child agent is spawned with `grant.proof.kind === "nexus"`, the engine issues a per-child attenuated Nexus API key at spawn time and revokes it on termination. As of #1425:

- `spawn-child.ts` (L1) calls `parentDelegation.grant()` and on termination fires `parentDel.revoke()` best-effort (fire-and-forget `.catch()`)
- Revoke failure emits a `console.warn` — the key stays active
- No retry queue, no integration test, no real Nexus HTTP implementation of `DelegationComponent`

`DelegationComponent` is fully defined in `@koi/core` (L0). This spec covers the L2 implementation backed by real Nexus HTTP.

---

## 2. Package structure

```
packages/security/nexus-delegation/
  src/
    delegation-api.ts              # NexusDelegationApi interface + fetch REST client
    scope-mapping.ts               # DelegationScope → NexusDelegateScope
    ttl-verify-cache.ts            # Stale-while-revalidate verify result cache
    nexus-delegation-backend.ts    # DelegationComponent impl + retry queue
    nexus-delegation-provider.ts   # ComponentProvider wrapper
    index.ts
    # colocated unit tests:
    delegation-api.test.ts
    scope-mapping.test.ts
    ttl-verify-cache.test.ts
    nexus-delegation-backend.test.ts
    nexus-delegation-provider.test.ts
  package.json    # deps: @koi/core, @koi/errors only
  tsconfig.json
  tsup.config.ts

packages/__tests__/nexus-delegation-integration.test.ts
```

**Layer: L2.** Imports `@koi/core` (L0) and `@koi/errors` (L0u) only. No `@koi/engine`, no `@koi/nexus-client`, no peer L2.

---

## 3. `NexusDelegationApi` — REST client

Defined and consumed entirely within this package — not extracted to a shared L0u package (YAGNI: nothing else needs this interface today).

### Endpoints

| Method | Endpoint | Purpose |
|--------|----------|---------|
| POST | `/api/v2/agents/delegate` | Create delegation grant (idempotent via `idempotency_key`) |
| DELETE | `/api/v2/agents/delegate/{id}` | Revoke delegation (Nexus cascades internally) |
| GET | `/api/v2/agents/delegate/{id}/chain` | Verify chain integrity |
| GET | `/api/v2/agents/delegate?cursor=` | List active delegations (paginated) |

### Interface

```typescript
interface NexusDelegationApi {
  readonly createDelegation: (req: NexusDelegateRequest) => Promise<Result<NexusDelegateResponse, KoiError>>;
  readonly revokeDelegation: (id: DelegationId) => Promise<Result<void, KoiError>>;
  readonly verifyChain: (id: DelegationId) => Promise<Result<NexusChainVerifyResponse, KoiError>>;
  readonly listDelegations: (cursor?: string) => Promise<Result<NexusDelegationListResponse, KoiError>>;
}
```

### Factory

```typescript
createNexusDelegationApi(config: {
  url: string;
  apiKey?: string;
  fetch?: FetchFn;         // injectable for testing
  deadlineMs?: number;     // default 45_000
}): NexusDelegationApi
```

**Retry policy:** GET endpoints retry up to 2× with exponential backoff + jitter (read-safe). POST/DELETE are non-retryable at the transport level — POST idempotency is handled via `idempotency_key`; DELETE idempotency is handled by treating `NOT_FOUND` as success in `revoke()`.

---

## 4. `NexusDelegationBackend` — `DelegationComponent` implementation

### Config

```typescript
interface NexusDelegationBackendConfig {
  readonly api: NexusDelegationApi;
  readonly agentId: AgentId;
  readonly maxChainDepth?: number;          // default 3
  readonly defaultTtlSeconds?: number;      // default 3600
  readonly namespaceMode?: NamespaceMode;   // default "copy"
  readonly canSubDelegate?: boolean;        // default true
  readonly verifyCacheTtlMs?: number;       // default 30_000; 0 = no cache
  readonly idempotencyPrefix?: string;      // present → deterministic key (Temporal path)
  readonly maxPendingRevocations?: number;  // default 100
  readonly maxRevocationRetries?: number;   // default 5
}
```

### `grant(scope, delegateeId, ttlMs?)`

1. POST `/api/v2/agents/delegate` with mapped scope + idempotency key
2. Cache grant locally: `Map<DelegationId, DelegationGrant>`
3. Return `DelegationGrant` with `proof: { kind: "nexus", token: resp.api_key }`

**Idempotency key:** `idempotencyPrefix + agentId:delegateeId` (Temporal path) or `randomUUID()` (general path).

### `revoke(id, cascade?)`

1. Attempt drain of pending retry queue (fire-and-forget, does not block)
2. DELETE `/api/v2/agents/delegate/{id}` — `NOT_FOUND` treated as success
3. Remove from local grant store + verify cache
4. On failure: enqueue to retry queue (see §5)

Note: `cascade` param is accepted by the interface but ignored — Nexus handles cascading server-side.

### `verify(id, toolId)`

1. **Local expiry check** — if expired, return `{ ok: false, reason: "expired" }`
2. **Local scope check** — if tool not in scope, return `{ ok: false, reason: "scope_exceeded" }`
3. **TTL verify cache** — serve fresh result immediately; serve stale + background-refresh (SWR)
4. **Nexus chain call** → `/chain` endpoint for crypto + revocation + chain depth
5. **Scope resolution** — prefer local grant store; fall back to Nexus-returned scope; fail-closed if neither available

### `list()`

Paginated GET, cursor-based. Prefers local grant data (has scope) over Nexus list entries (scope-less).

---

## 5. Retry queue (private implementation detail)

Private state inside `NexusDelegationBackend`. Not exported, not configurable beyond the two config fields.

### Shape

```typescript
interface PendingRevocation {
  readonly id: DelegationId;
  readonly childId: AgentId;  // for structured error log
  readonly failedAt: number;
  attempts: number;            // mutable counter
}
```

### Behavior

- **On revoke failure:** push to `pendingRevocations[]`
  - If queue is full (≥ `maxPendingRevocations`): drop oldest entry with a structured `console.error` log containing `{ delegationId, childId, droppedAt }`
- **On every `revoke()` call:** trigger a background drain (opportunistic, fire-and-forget via `void drainQueue()`)
  - Each pending entry retried once per drain cycle
  - On retry success: remove from queue
  - On retry failure: `attempts++`; if `attempts >= maxRevocationRetries` emit structured `console.error` with `{ delegationId, childId, attempts, error }` and drop; otherwise re-enqueue
- Drain is non-blocking — does not delay the primary `revoke()` call

---

## 6. `NexusDelegationProvider` — ComponentProvider

```typescript
createNexusDelegationProvider(config: {
  api: NexusDelegationApi;
  backend?: Partial<Omit<NexusDelegationBackendConfig, "api" | "agentId">>;
  enabled?: boolean;   // default true
}): ComponentProvider
```

`attach(agent)` creates a `NexusDelegationBackend` with `agentId = agent.pid.id`. Returns `Map { DELEGATION → backend }`. The `api` instance is shared across all agents assembled in the same `createKoi` call (single HTTP connection pool).

### Wiring into `createKoi`

No changes to `createKoi` or `spawn-child.ts`. Consumers pass the provider at assembly time:

```typescript
createKoi({
  manifest,
  adapter,
  providers: [
    createNexusDelegationProvider({ api: nexusDelegationApi }),
  ],
})
```

`manifest.delegation.backend === "nexus"` is a consumer-level convention. The provider must still be passed explicitly — no auto-discovery at L1 (that would leak L2 knowledge into the kernel). Consumers (CLI, `@koi/runtime`) check the manifest field and conditionally include the provider.

**Note:** `DelegationConfig` in `@koi/core` does not currently have a `backend` field (`enabled`, `maxChainDepth`, `defaultTtlMs`, `required?`, `namespaceMode?` are the current fields). If manifest-driven backend routing is desired, a `backend?: "nexus" | "memory"` field should be added to `DelegationConfig` in a separate L0 PR before or alongside this work.

---

## 7. Integration tests

### Unit tests (no docker, always run in CI)

Uses an injectable `fetch` mock that returns pre-canned HTTP responses.

| Test | What it covers |
|------|----------------|
| grant() → POST called with correct scope + idempotency key | `nexus-delegation-backend.test.ts` |
| grant() proof.kind === "nexus", token set | `nexus-delegation-backend.test.ts` |
| revoke() → DELETE called; NOT_FOUND treated as success | `nexus-delegation-backend.test.ts` |
| revoke() failure → enqueued; drained on next revoke() | `nexus-delegation-backend.test.ts` |
| max retries exceeded → structured console.error, dropped | `nexus-delegation-backend.test.ts` |
| queue full → oldest dropped with console.error | `nexus-delegation-backend.test.ts` |
| verify() local expiry fast path | `nexus-delegation-backend.test.ts` |
| verify() SWR cache (stale served, background refresh) | `nexus-delegation-backend.test.ts` |
| scope-mapping DelegationScope ↔ NexusDelegateScope | `scope-mapping.test.ts` |
| ComponentProvider attaches DELEGATION component | `nexus-delegation-provider.test.ts` |

### Spawn lifecycle tests (mock API, always run in CI)

`packages/__tests__/nexus-delegation-integration.test.ts`

| Test | What it covers |
|------|----------------|
| spawn → key issued → termination → revoke called once | Happy path |
| Abnormal child termination → revoke still fires | Termination handler invariant |
| revoke failure → retry on next termination | Retry queue drain |
| maxRevocationRetries exceeded → structured error log | Error surface |

### Docker integration tests (guarded by `NEXUS_URL`)

Run via `bun test --tag integration` in integration CI only (skipped locally without docker).

- Child key has shorter TTL + narrower scope than parent key (attenuation verified)
- POST-revoke key lookup returns 404 (key is actually invalidated)
- Child terminates abnormally → key still revoked within grace period

---

## 8. Acceptance criteria (from issue #1473)

- [ ] `NexusDelegationBackend` passes unit tests with mocked Nexus HTTP client
- [ ] Integration test: spawn → Nexus key issued → child terminates → key verified revoked
- [ ] Retry queue: failed revocations retried on next termination, structured error log after max retries
- [ ] `check:layers` passes (L2 package does not import L1)
- [ ] Golden query updated if delegation affects trajectory output

---

## 9. Files not modified

- `packages/kernel/core/src/delegation.ts` — L0 interface is complete, no changes needed
- `packages/kernel/engine/src/spawn-child.ts` — already calls `grant()`/`revoke()` correctly; no changes needed
- `packages/security/governance-delegation/` — stays HTTP-free, in-memory capability verifier only
- `packages/lib/nexus-client/` — NFS JSON-RPC transport; delegation REST is separate concern

---

## 10. References

- `packages/kernel/core/src/delegation.ts` — `DelegationComponent` L0 interface
- `packages/kernel/engine/src/spawn-child.ts:610–623` — current revoke fire-and-forget
- `archive/v1/packages/security/delegation-nexus/` — v1 reference implementation
- `archive/v1/packages/lib/nexus-client/src/delegation-api.ts` — Nexus REST API shape
- Issue #1395 — delegation chain + capability verification
- Issue #1425 — spawn inheritance policy (where gap was discovered)
