# @koi/nexus-delegation

**Layer:** L2
**Package:** `packages/security/nexus-delegation`
**Issue:** #1473

Nexus-backed `DelegationComponent` implementation. Mints a per-child Nexus API key
on every spawn, attenuates capability scope from parent to child, and revokes the
key when the child terminates. Designed to replace process-inherited
`NEXUS_API_KEY` credentials with short-lived, child-specific ones so a misbehaving
or compromised sub-agent cannot use the parent's full credential.

## Design

Three layers:

1. **DelegationApi** (`createNexusDelegationApi`) — typed wrapper over the
   Nexus v2 REST endpoints (`POST /api/v2/agents/delegate`, `DELETE`,
   `GET /chain`, `GET` list). Handles HTTP, idempotency keys, and error mapping.
2. **DelegationBackend** (`createNexusDelegationBackend`) — `DelegationComponent`
   implementation. Owns local grant store, TTL verify cache, retry queue for
   transient revoke failures, and tombstone tracking for in-flight revoke/verify
   races. Maps Koi's `DelegationScope` to Nexus's `add_grants`/`remove_grants`
   wire format.
3. **DelegationProvider** (`createNexusDelegationProvider`) — `ComponentProvider`
   that wires the backend into an Agent's component map under the `DELEGATION`
   subsystem token. Used by `@koi-agent/cli` when manifests declare
   `delegation: { backend: "nexus" }`.

## API

```typescript
import {
  createNexusDelegationApi,
  createNexusDelegationBackend,
  createNexusDelegationProvider,
} from "@koi/nexus-delegation";

// 1. Build the HTTP api wrapper
const api = createNexusDelegationApi({
  url: "http://nexus.internal:2026",
  apiKey: process.env.NEXUS_API_KEY,   // parent's root credential
});

// 2. Build the backend
const backend = createNexusDelegationBackend({
  api,
  agentId: parentAgentId,
  maxChainDepth: 3,
  defaultTtlSeconds: 3600,
  verifyCacheTtlMs: 30_000,
  // Optional: deterministic idempotency keys for cross-call replay (caller-managed)
  // idempotencyPrefix: "spawn-",
});

// 3. Or use the ComponentProvider for assembly-time wiring
const provider = createNexusDelegationProvider({ api });
```

## DelegationComponent surface

```typescript
backend.grant(scope, delegateeId, ttlMs?): Promise<DelegationGrant>
backend.revoke(id, cascade?): Promise<void>
backend.verify(id, toolId): Promise<DelegationVerifyResult>
backend.list(): Promise<readonly DelegationGrant[]>
```

`grant()` returns a `DelegationGrant` with `proof.kind === "nexus"` and
`proof.token = <child-api-key>`. The token is propagated into the child's `ENV`
component as `NEXUS_API_KEY` by `spawn-child` so any in-process Nexus client
constructed AFTER the env merge observes the attenuated key.

## Spawn lifecycle

`@koi/engine`'s `spawnChildAgent` consumes the parent's `DelegationComponent`:

1. **Assembly-time grant**: a `delegation-grant-env` `ComponentProvider` runs at
   `COMPONENT_PRIORITY.GLOBAL_FORGED` (50) so it wins ENV over the bundled
   `agent-env-provider` (100). It calls `parent.grant(childScope, child.id)`,
   captures `delegationId` + `nexusApiKey`, and installs the latter into the
   child's ENV.
2. **Termination revoke**: when the child handle emits `terminated`, the parent
   `DelegationComponent.revoke()` is invoked. The dispose path also awaits
   revoke (bounded by `REVOKE_DISPOSE_TIMEOUT_MS = 5000`) so host teardown
   cannot complete with a per-child key still active server-side.
3. **Retry on transient failure**: failed revokes are tombstoned locally
   (deny-fast on `verify()`) and queued for opportunistic retry on subsequent
   `revoke()` calls.

## Race-handling guarantees

The backend handles several concurrency scenarios:

- **Drain serialization**: `grant()` awaits any in-flight drain BEFORE calling
  `createDelegation`, so a stale revoke for the same delegation_id cannot race
  Nexus's idempotency replay window.
- **Verify-vs-revoke**: tombstones survive verify-cache TTL, so a positive
  cache entry cannot authorize a tool call after a concurrent revoke.
- **Drain re-entry**: drains chain via `drainInProgress` to enforce FIFO
  ordering; concurrent revokes do not interleave snapshots.
- **Bounded dispose**: registry-path AND no-registry-path dispose both bound
  on `REVOKE_DISPOSE_TIMEOUT_MS`. A failed bounded revoke clears the memo so
  subsequent dispose attempts retry.

## Known limitations

- **Deterministic idempotency mode**: when callers opt into
  `idempotencyPrefix`, concurrent grant+revoke for the same delegation_id can
  produce same-id replay races. Default `uuid`-suffixed mode is unaffected
  because every grant returns a fresh delegation_id.
- **In-process L2 credential rebinding**: L2 packages that capture
  `process.env.NEXUS_API_KEY` at construction (e.g., `@koi/fs-nexus`) keep the
  parent's key. Per-child key delivery is via `ENV` component; consumers that
  read process.env directly do not benefit. Tracked as a follow-up.
- **Outer-spawn idempotency**: a host that retries an entire spawn (new child
  AgentId, new uuid) creates a fresh delegation. Caller-supplied stable spawn
  ids would collapse retries onto one delegation. Tracked as a follow-up.

## Manifest opt-in

```yaml
# packs/foo/agent.yaml
delegation:
  backend: nexus            # or "memory" (default)
  enabled: true             # spawn-child grants per-child credentials
  required: true            # spawn fails if grant() rejects
  maxChainDepth: 3
  defaultTtlMs: 3600000
```

`@koi-agent/cli`'s `tui-command.ts` reads the manifest and instantiates the
provider when `backend === "nexus"` AND `NEXUS_URL` is set.

## See also

- [@koi/permissions-nexus](./permissions-nexus.md) — capability policy persistence
- [@koi/fs-nexus](./fs-nexus.md) — Nexus-backed filesystem
- [@koi/audit-sink-nexus](./audit-sink-nexus.md) — audit log shipping
