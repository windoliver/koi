# @koi/permissions-nexus

**Layer:** L2
**Package:** `packages/security/permissions-nexus`
**Issue:** #1399

Nexus-backed permission persistence, cross-node synchronization, and delegation
hooks for the Koi permission system.

## Design: local-first

`check()` ALWAYS delegates to an in-process `PermissionBackend`. Nexus is
never on the hot path. On construction, the current policy is written to
Nexus (write-through). A background poller syncs policy changes from Nexus
at a configurable interval (default 30s). If Nexus is down, the agent runs
on its last-known local rules — no decisions are ever blocked.

## API

```typescript
import { createNexusPermissionBackend } from "@koi/permissions-nexus";
import { createPermissionBackend } from "@koi/permissions";
import { createHttpTransport } from "@koi/nexus-client";

const rules = loadMyRules(); // SourcedRule[]
const transport = createHttpTransport({ url: "http://nexus:3100" });

const backend = createNexusPermissionBackend({
  transport,
  localBackend: createPermissionBackend({ mode: "default", rules }),
  getCurrentPolicy: () => rules,
  rebuildBackend: (policy) =>
    createPermissionBackend({ mode: "default", rules: policy as SourcedRule[] }),
  syncIntervalMs: 30_000,   // 0 = disable polling
  policyPath: "koi/permissions",
});

// Hot path — always local, always fast
const decision = await backend.check({ principal, action, resource });

// Cleanup
backend.dispose();
```

## Config

```typescript
interface NexusPermissionsConfig {
  readonly transport: NexusTransport;
  readonly localBackend: PermissionBackend;       // evaluated on every check()
  readonly getCurrentPolicy: () => unknown;        // serialize current rules to JSON
  readonly rebuildBackend: (p: unknown) => PermissionBackend; // reconstruct from Nexus policy
  readonly syncIntervalMs?: number;               // default: 30_000; 0 = disabled
  readonly policyPath?: string;                   // default: "koi/permissions"
}
```

## Nexus storage layout

```
{policyPath}/policy.json        — serialized policy (getCurrentPolicy() output)
{policyPath}/version.json       — { version: number, updatedAt: number }
{policyPath}/tuples/{id}.json   — RelationshipTuple[] for delegation grants
{policyPath}/revocations/{id}.json — { revoked: true, cascade: boolean }
```

## RevocationRegistry

```typescript
const registry = createNexusRevocationRegistry({ transport });
await registry.isRevoked(id);       // fail-closed: error → true
await registry.isRevokedBatch(ids); // parallel reads, fail-closed
await registry.revoke(id, cascade); // writes revocation record
```

## Delegation hooks

```typescript
const hooks = createNexusDelegationHooks({ transport });
// onGrant — fail-closed: throws on Nexus write failure (grant rolled back)
// onRevoke — best-effort: silently swallows failures
```

## Fallback behavior

| Scenario | Result |
|----------|--------|
| Nexus unreachable at startup | Warn, run local-only |
| Nexus write-through failure | Log, non-fatal |
| Poll read failure | Log, keep local rules |
| `isRevoked` error | Return `true` (fail-closed) |
| `onGrant` failure | Throw (grant rolled back) |
| `onRevoke` failure | Swallow |

## Boot-sync controls (#1401 Phase 2)

For boot modes that must positively confirm a remote policy load (see
`docs/L3/cli.md`, "Nexus boot modes"), the backend exposes:

- `bootSyncDeadlineMs?: number` — caps the initial sync read; threaded
  through to `transport.call({ deadlineMs, signal })`.
- `abortInFlightSync()` — aborts the in-flight initial-sync `read`. Backed
  by an internal `AbortController` so the underlying transport call is
  truly cancelled (not just bookkeeping).
- `isCentralizedPolicyActive()` — true once the first successful Nexus
  read installed remote policy; used by `assert-remote-policy-loaded-at-boot`
  to refuse to boot when the sync resolved without activating remote rules.

`dispose()` also calls `abortInFlightSync()` to ensure rejected boots do
not leak polling timers or open transport reads.
