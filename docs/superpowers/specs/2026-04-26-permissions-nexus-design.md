# Design: `@koi/permissions-nexus` — Nexus Permission Integration

**Date:** 2026-04-26
**Issue:** [#1399](https://github.com/windoliver/koi/issues/1399)
**Approach:** B — Local-first with Nexus write-through + polling sync

---

## Overview

Adds Nexus-backed permission persistence, audit trail, cross-node synchronization, and policy distribution to the Koi permission system. Nexus is optional — all permission decisions are evaluated locally; Nexus is used only for persistence and sync.

---

## Package Structure

Three new packages, one modification:

| Package | Layer | Purpose |
|---------|-------|---------|
| `@koi/nexus-client` | L0u | Shared JSON-RPC HTTP transport extracted from `@koi/fs-nexus` |
| `@koi/permissions-nexus` | L2 | Write-through permission backend + sync + delegation hooks |
| `@koi/audit-sink-nexus` | L2 | Nexus-backed `AuditSink` (batched writes, queryable) |
| `@koi/fs-nexus` | L2 | Modified to import transport from `@koi/nexus-client` |

### `@koi/nexus-client` (L0u)

Extracted from `packages/lib/fs-nexus/src/transport.ts`. Exports:

```typescript
export interface NexusTransport {
  readonly call: <T>(method: string, params: Record<string, unknown>) => Promise<Result<T, KoiError>>;
  readonly close: () => void;
}

export interface NexusTransportConfig {
  readonly url: string;
  readonly apiKey?: string;
  readonly deadlineMs?: number;
  readonly retries?: number;
  readonly fetch?: typeof globalThis.fetch;
}

export function createHttpTransport(config: NexusTransportConfig): NexusTransport;
```

The v2 transport already has retries, exponential backoff, per-request deadline, and `AbortSignal` — it moves as-is. `@koi/fs-nexus` drops its inline copy and imports from here. Added to `scripts/layers.ts` as L0u.

### `@koi/permissions-nexus` (L2)

```typescript
export function createNexusPermissionBackend(config: NexusPermissionsConfig): PermissionBackend;
export function createNexusRevocationRegistry(config: NexusPermissionsConfig): RevocationRegistry;
export function createNexusDelegationHooks(config: NexusPermissionsConfig): NexusDelegationHooks;
export function validateNexusPermissionsConfig(raw: unknown): Result<NexusPermissionsConfig, KoiError>;

export interface NexusPermissionsConfig {
  readonly transport: NexusTransport;
  readonly localBackend: PermissionBackend;
  readonly syncIntervalMs?: number;   // default: 30_000; 0 = disable polling
  readonly policyPath?: string;       // default: "koi/permissions"
}

export interface NexusDelegationHooks {
  readonly onGrant: (grant: DelegationGrant) => Promise<void>;
  readonly onRevoke: (grantId: DelegationId, cascade: boolean) => Promise<void>;
}
```

### `@koi/audit-sink-nexus` (L2)

```typescript
export function createNexusAuditSink(config: NexusAuditSinkConfig): AuditSink;
export function validateNexusAuditSinkConfig(raw: unknown): Result<NexusAuditSinkConfig, KoiError>;

export interface NexusAuditSinkConfig {
  readonly transport: NexusTransport;
  readonly basePath?: string;         // default: "koi/audit"
  readonly batchSize?: number;        // default: 20
  readonly flushIntervalMs?: number;  // default: 5_000
}
```

---

## Architecture: Local-First with Write-Through

### Hot path (every tool call)

```
check(query)
  └─▶ localBackend.check(query)   ← pure local evaluation, no network
        └─▶ PermissionDecision
```

The local backend is always the decision authority. Nexus is never on the hot path.

### Write-through on rule change

Rules are immutable at construction time (matching `PermissionBackend` contract). Write-through fires when a new `NexusPermissionBackend` is created with updated rules (e.g. after governance approval rewrites the rule set):

```
createNexusPermissionBackend({ transport, localBackend: newBackend, ... })
  ├─▶ newBackend is the live decision authority immediately
  └─▶ write policy.json + bump version.json ← async, best-effort (non-fatal on failure)
```

### Polling sync (cross-node propagation)

```
every syncIntervalMs:
  ├─▶ fetch version.json from Nexus
  │     ├─▶ version unchanged → skip (cheap)
  │     └─▶ version changed →
  │           ├─▶ fetch policy.json
  │           ├─▶ deserialize SourcedRule[]
  │           └─▶ atomically replace localBackend
  └─▶ (on error) log + back off, keep current local rules
```

### Startup

1. Fetch `{policyPath}/policy.json` from Nexus
2. If present → build local backend from Nexus policy (Nexus wins)
3. If missing → write local rules to Nexus (this node becomes initial authority)
4. If Nexus unreachable → log warning, run local-only; poller starts and retries

---

## Nexus Storage Layout

| Data | Path | Format |
|------|------|--------|
| Permission policy | `{policyPath}/policy.json` | `SourcedRule[]` |
| Policy version tag | `{policyPath}/version.json` | `{ version: number, updatedAt: number }` |
| Delegation tuples | `{policyPath}/tuples/{grantId}.json` | `RelationshipTuple[]` |
| Revocations | `{policyPath}/revocations/{grantId}.json` | `{ revoked: true, cascade: boolean }` |
| Audit entries | `{basePath}/{sessionId}/{timestamp}-{turnIndex}-{kind}-{seq}.json` | `AuditEntry` |

### Policy version tag

Nexus stores a monotonic `version` counter and `updatedAt` timestamp alongside the policy. The poller compares `version` on each tick and skips the full policy fetch when unchanged — keeping the polling cost to one lightweight read.

---

## Delegation Hooks

**`onGrant`** — fail-closed:
1. Map `DelegationGrant` → `RelationshipTuple[]` (same `mapGrantToTuples` logic as v1)
2. Write each tuple to `{policyPath}/tuples/{grantId}.json`
3. On failure: throw → `DelegationManager` rolls back the grant

**`onRevoke`** — best-effort:
1. Write `{ revoked: true, cascade }` to `{policyPath}/revocations/{grantId}.json`
2. On failure: silently swallow (revocation is the safety operation — local revocation already applied)

---

## RevocationRegistry

- `isRevoked(id)` → read `revocations/{id}.json`; missing = not revoked; any error = fail-closed (return `true`)
- `isRevokedBatch(ids)` → parallel reads via `Promise.allSettled`; failed reads = revoked

---

## Error Handling

| Scenario | Behavior |
|----------|----------|
| Nexus unreachable at startup | Warn + run local-only; poller retries on interval |
| Write-through failure | Log error, non-fatal — local rules already updated |
| Poll read failure | Log, keep current local rules, retry next interval |
| `isRevoked` Nexus error | Fail-closed → return `true` (treat as revoked) |
| `onGrant` write failure | Fail-closed → throw (grant rolled back) |
| `onRevoke` write failure | Best-effort → silently swallow |
| Malformed policy from Nexus | Log + skip update → keep current local rules |
| `dispose()` called | Cancel polling interval, flush pending writes |

---

## Testing

### `@koi/permissions-nexus`

| Test | What it proves |
|------|---------------|
| `check()` uses local backend, no Nexus call | Hot path never touches network |
| New backend construction writes policy to Nexus | Write-through works |
| Poll detects version change → rebuilds local backend | Cross-node sync propagates changes |
| Poll skips fetch when version unchanged | Cache hit returns correct permission |
| Nexus unreachable at startup → local-only | Missing Nexus falls back to local |
| Nexus goes down mid-session → local rules remain | Resilience |
| `isRevoked` Nexus error → returns `true` | Fail-closed |
| `onGrant` failure → throws | Grant rolled back |
| `onRevoke` failure → no throw | Best-effort |
| `dispose()` cancels polling interval | No timer leak |

### `@koi/audit-sink-nexus`

| Test | What it proves |
|------|---------------|
| `log()` batches entries | Batching works |
| Batch flushes at size threshold | Size trigger works |
| Batch flushes on `flush()` | Explicit flush works |
| `query()` flushes then reads from Nexus | Query returns current entries |
| Write failure re-enqueues entry | Retry on next flush |
| `flush()` propagates write error | Error surface on flush |

All tests use `bun:test` with an injected fake `NexusTransport` (< 40 LOC). No real Nexus server required.

---

## File Layout

### `packages/lib/nexus-client/`
```
src/
  transport.ts        # createHttpTransport (moved from @koi/fs-nexus)
  types.ts            # NexusTransport, NexusTransportConfig
  errors.ts           # mapNexusError (moved from @koi/fs-nexus)
  index.ts
  transport.test.ts
package.json
tsconfig.json
tsup.config.ts
```

### `packages/security/permissions-nexus/`
```
src/
  config.ts                     # NexusPermissionsConfig + validateNexusPermissionsConfig
  nexus-permission-backend.ts   # createNexusPermissionBackend (local-first + write-through + polling)
  nexus-revocation-registry.ts  # createNexusRevocationRegistry (fail-closed)
  nexus-delegation-hooks.ts     # createNexusDelegationHooks (onGrant/onRevoke)
  types.ts                      # RelationshipTuple, internal storage types
  index.ts
  nexus-permission-backend.test.ts
  nexus-revocation-registry.test.ts
  nexus-delegation-hooks.test.ts
  config.test.ts
package.json
tsconfig.json
tsup.config.ts
```

### `packages/security/audit-sink-nexus/`
```
src/
  config.ts           # NexusAuditSinkConfig + validateNexusAuditSinkConfig
  nexus-sink.ts       # createNexusAuditSink (batched writes, queryable)
  index.ts
  nexus-sink.test.ts
  config.test.ts
package.json
tsconfig.json
tsup.config.ts
```

---

## Layer Compliance

- `@koi/nexus-client` (L0u): imports `@koi/core` only
- `@koi/permissions-nexus` (L2): imports `@koi/core`, `@koi/nexus-client` (L0u), `@koi/permissions` (L2 peer — injected, not imported directly)
- `@koi/audit-sink-nexus` (L2): imports `@koi/core`, `@koi/nexus-client` (L0u)

`@koi/permissions-nexus` takes `PermissionBackend` as an injected interface from `@koi/core`, not a direct import of `@koi/permissions`. Layer clean: L2 → L0 + L0u only.

---

## Runtime Wiring

Per CLAUDE.md golden query rule, both new L2 packages must be wired into `@koi/runtime`:

1. Add `@koi/permissions-nexus` and `@koi/audit-sink-nexus` as `@koi/runtime` deps
2. Add 2 standalone golden queries per package in `golden-replay.test.ts`:
   - `permissions-nexus-fallback`: local-only backend, Nexus transport returns errors → all checks pass locally
   - `permissions-nexus-sync`: fake transport returns updated policy → local backend rebuilt
   - `audit-sink-nexus-log`: entries buffered and flushed to fake transport
   - `audit-sink-nexus-query`: flush then read returns sorted entries

---

## LOC Estimate

| Package | Source LOC | Test LOC |
|---------|-----------|---------|
| `@koi/nexus-client` | ~100 (moved, not new) | ~80 |
| `@koi/permissions-nexus` | ~250 | ~300 |
| `@koi/audit-sink-nexus` | ~150 (ported from v1) | ~150 |
| `@koi/fs-nexus` delta | ~-80 (remove inline transport) | — |
| Runtime wiring | ~60 | ~120 |
| **Total new logic** | **~480** | **~650** |

Fits within one reviewable PR (logic LOC < 500, tests separate).

---

## Non-Goals

- No Nexus push/webhook — polling is sufficient for cross-node sync
- No real-time invalidation — eventual consistency within one poll interval is acceptable
- No Nexus-side evaluation engine — local `@koi/permissions` evaluator is always used
- No new L0 types — all interfaces already exist in `@koi/core`
- No UI or TUI changes
