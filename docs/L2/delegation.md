# @koi/delegation — Agent-to-Agent Permission Delegation

Monotonic attenuation delegation tokens with HMAC-SHA256 signing, cascading revocation, and a pull-model capability request bridge. Provides both **push** (grant at spawn) and **pull** (request on demand) delegation between agents.

---

## Why It Exists

1. **Agents need scoped access.** A parent agent spawning a child for a subtask should grant only the permissions the child needs — not its full capability set. Monotonic attenuation ensures child scope <= parent scope.

2. **Permissions change mid-task.** A child agent may discover it needs file access it wasn't granted at spawn. Without a pull model, it has no way to ask — it fails or halts.

3. **Humans must stay in the loop.** Sensitive capability grants (write access, network access) should flow through human approval (HITL) before being issued. The bridge integrates with the existing `requestApproval` contract.

4. **Revocation must cascade.** When a parent's grant is revoked, all child grants derived from it must be revoked too — immediately, not on next check.

---

## What This Enables

### Push Model (grant at spawn)

```
Parent spawns Child with { allow: ["read_file"], resources: ["read_file:/src/**"] }
  → DelegationManager.grant() → HMAC-signed grant token
  → Child can call read_file on /src/** paths
  → Parent revokes → Child loses access immediately (cascade)
```

### Pull Model (request on demand)

```
Child discovers it needs write_file access mid-task
  → Child calls delegation_request tool
  → Mailbox message → Parent agent
  │
  ├─ Tier 1 (instant): canAutoGrant policy returns true?
  │   → auto-grant → response to Child
  │
  └─ Tier 2 (next turn):
      ├─ HITL: human approves/modifies/denies → response
      └─ No HITL: bubble-up to grandparent → same tiers
```

---

## Architecture

### Layer

`@koi/delegation` is an **L2 feature package**. It imports only from `@koi/core` (L0).

### Module Map

```
src/
├── delegation-manager.ts       Central coordinator (grant/revoke/verify/list)
├── delegation-provider.ts      ComponentProvider: attaches tools + DELEGATION component
├── capability-request-bridge.ts  Pull-model bridge (ComponentProvider + KoiMiddleware)
├── capability-request-constants.ts  Message types, response statuses, defaults
├── wait-for-response.ts        Mailbox response waiter with timeout/abort
├── middleware.ts               KoiMiddleware for grant verification on tool calls
├── grant.ts                    Grant creation + monotonic attenuation
├── revoke.ts                   Cascading revocation
├── sign.ts                     HMAC-SHA256 signing/verification
├── verify.ts                   Full grant verification pipeline
├── verify-cache.ts             Content-based verification cache (1024 entries)
├── circuit-breaker.ts          Per-delegatee circuit breaker state machine
├── registry.ts                 In-memory revocation registry + grant index
├── resource-pattern.ts         Parses tool:path resource patterns
├── test-helpers.ts             Test utilities (async registry, grant factory)
└── tools/
    ├── constants.ts            Operations: grant, revoke, list, request
    ├── grant.ts                delegation_grant tool factory
    ├── revoke.ts               delegation_revoke tool factory
    ├── list.ts                 delegation_list tool factory
    └── request.ts              delegation_request tool factory (pull model)
```

### Key Components

| Component | Type | Purpose |
|-----------|------|---------|
| `DelegationManager` | Factory | Central coordinator: grant, revoke, verify, list |
| `DelegationProvider` | `ComponentProvider` | Attaches push tools + DELEGATION ECS component |
| `CapabilityRequestBridge` | `ComponentProvider` + `KoiMiddleware` | Pull-model: Tier 1 auto-grant + Tier 2 HITL/bubble-up |
| `DelegationMiddleware` | `KoiMiddleware` | Verifies grants on every tool call (priority 120) |

---

## Push Model: Delegation Tools

### delegation_grant

Grants another agent scoped access to tools and resources.

```typescript
// Agent calls the tool:
{
  delegateeId: "child-agent-1",
  permissions: { allow: ["read_file", "write_file"] },
  resources: ["read_file:/src/**", "write_file:/src/output/**"],
  ttlMs: 3600000  // 1 hour
}
// Returns: { grantId: "dlg_abc123", scope: { ... }, expiresAt: 1709424000000 }
```

### delegation_revoke

Revokes a previously issued grant, optionally cascading to all derived grants.

```typescript
{ grantId: "dlg_abc123", cascade: true }
// Returns: { revokedIds: ["dlg_abc123", "dlg_def456"] }
```

### delegation_list

Lists all active grants issued by the calling agent.

---

## Pull Model: Capability Request Bridge

### delegation_request

A child agent requests capabilities it doesn't have. Blocks until granted, denied, or timed out.

```typescript
// Child agent calls:
{
  targetAgentId: "parent-agent-1",
  permissions: { allow: ["read_file"] },
  resources: ["read_file:/workspace/logs/**"],
  reason: "Need to read log files to diagnose the reported error",
  timeoutMs: 30000
}
// Returns: { granted: true, grantId: "dlg_xyz789", scope: { ... } }
// or:      { granted: false, reason: "denied" }
// or:      { granted: false, reason: "timeout" }
```

### Two-Tier Handler (receiver side)

**Tier 1 — Instant (in `onMessage` handler):**
- Checks `canAutoGrant(agentScope, requestedScope)` callback
- If true → `manager.grant()` → immediate response
- If false or not configured → queues for Tier 2

**Tier 2 — At next turn start (`onBeforeTurn`):**
- If `requestApproval` exists → HITL: human sees the request and approves/modifies/denies
- If no `requestApproval` → bubble-up: forward to parent agent with preserved `requesterId`
- Configurable approval timeout (default 60s) and forward depth limit (default 5)

### Bubble-Up Routing

When a mid-level agent has no HITL handler, the request forwards up the agent tree:

```
Grandchild → Child (no HITL) → Parent (has HITL) → Human approves
                                                  → Response sent directly to Grandchild
```

The `requesterId` and `_originalCorrelationId` fields preserve the original requester through the forward chain, so the response goes directly back to the agent that asked.

---

## Governance Integration

Wire both push and pull models through `createGovernanceStack`:

```typescript
import { createGovernanceStack } from "@koi/governance";
import { createDelegationManager } from "@koi/delegation";

const manager = createDelegationManager({
  config: { secret: "...", maxChainDepth: 5, defaultTtlMs: 3600000 },
  onGrant: async (grant) => { /* write ReBAC tuple to Nexus */ },
  onRevoke: async (id, cascade) => { /* revoke ReBAC tuple */ },
});

const { middlewares, providers } = createGovernanceStack({
  // Push model: grant/revoke/list tools + DELEGATION component
  delegationBridge: { manager },
  // Pull model: delegation_request tool + capability request bridge
  capabilityRequest: {
    approvalTimeoutMs: 60_000,
    maxForwardDepth: 5,
  },
});
```

Priority order in the governance stack:
- 100: `koi:permissions` (coarse-grained allow/deny)
- 110: `koi:exec-approvals` (progressive command allowlisting)
- 120: `koi:delegation` (grant verification on tool calls)
- **125: `koi:capability-request` (pull-model request handling)**
- 150: `koi:governance-backend` (policy evaluation gate)

---

## Dynamic Permission Management

Three safety controls for delegation grant lifecycle, added in #644.

### Escalation Prevention

Agents cannot grant permissions they don't hold. When `permissionBackend` is configured on the manager, every `grant()` and `attenuate()` call checks that the grantor holds all permissions being delegated. Batch check first, fail-fast sequential fallback. Backend errors are fail-closed (deny).

```typescript
const manager = createDelegationManager({
  config,
  permissionBackend: myBackend, // ← enables escalation prevention
});

// Agent "coder" has read_file only — tries to grant deploy → DENIED
await manager.grant(agentId("coder"), agentId("helper"), {
  permissions: { allow: ["deploy"] },
});
// → { ok: false, error: { code: "PERMISSION", message: "Escalation denied..." } }
```

### Session-Scoped Grants

Grants can be tied to a session via `scope.sessionId`. When `getActiveSessions` is configured, `verify()` checks the session is still active before allowing tool calls. When the session ends, all its grants become invalid immediately — no explicit revocation needed.

```typescript
const manager = createDelegationManager({
  config,
  getActiveSessions: () => activeSessions, // ← Set<string> of live session IDs
});

// Grant tied to a session
await manager.grant(agentId("parent"), agentId("child"), {
  permissions: { allow: ["read_file"] },
  sessionId: "session-42", // ← new field on DelegationScope
});

// After session ends: verify() → { ok: false, reason: "session_expired" }
```

### Nexus ReBAC Tuple Sync

Grant and revoke events can be synced to Nexus (Zanzibar-style authorization) via hook factories from `@koi/permissions-nexus`:

```typescript
import { createNexusOnGrant, createNexusOnRevoke } from "@koi/permissions-nexus";

const manager = createDelegationManager({
  config,
  onGrant: createNexusOnGrant(nexusBackend),   // async-blocking, fail-closed
  onRevoke: createNexusOnRevoke(nexusBackend, getGrant), // best-effort
});
```

`mapGrantToTuples()` converts a `DelegationGrant` to Zanzibar tuples:
- Each (permission, resource) pair → one tuple
- Without resources: `subject: "agent:<delegateeId>"`, `relation: <permission>`, `object: "delegation:<grantId>"`

### delegation_check Tool

Agents can verify a delegated permission before acting:

```typescript
// Agent calls: delegation_check({ grantId: "g-abc", permission: "read_file" })
// → { allowed: true }
// → { allowed: false, reason: "session_expired" }
// → { allowed: false, reason: "unknown_grant" }
```

When `permissionBackend` is configured on the provider, the check also queries the backend after grant verification.

### Attenuate via delegation_grant

The `delegation_grant` tool now accepts an optional `parentGrantId` field. When present, it calls `manager.attenuate()` instead of `manager.grant()`, enabling re-delegation:

```typescript
// Agent calls:
{
  delegateeId: "intern",
  permissions: { allow: ["read_file"] },  // must be subset of parent
  parentGrantId: "g-root"                 // attenuates this grant
}
```

---

## Governance Integration (Expanded)

```typescript
const { middlewares, providers, nexusHooks } = createGovernanceStack({
  delegationBridge: {
    manager,
    permissionBackend: nexusBackend,  // enables delegation_check tool
    nexusBackend,                     // produces nexusHooks on bundle
  },
  capabilityRequest: { approvalTimeoutMs: 60_000 },
});

// nexusHooks.onGrant / nexusHooks.onRevoke — wire to a new manager if needed
```

---

## Configuration

### DelegationManager

| Option | Default | Description |
|--------|---------|-------------|
| `secret` | (required) | HMAC-SHA256 signing key |
| `maxChainDepth` | 3 | Maximum grant delegation chain depth |
| `defaultTtlMs` | 3600000 | Default grant TTL (1 hour) |
| `circuitBreaker` | `DEFAULT_CIRCUIT_BREAKER_CONFIG` | Per-delegatee circuit breaker thresholds |
| `onGrant` | — | Hook called on grant creation (throw to roll back) |
| `onRevoke` | — | Hook called on revocation (best-effort, no rollback) |
| `permissionBackend` | — | Enables escalation prevention at grant-time |
| `getActiveSessions` | — | Enables session-scoped grant verification |

### CapabilityRequestBridge

| Option | Default | Description |
|--------|---------|-------------|
| `manager` | (required) | The DelegationManager instance |
| `canAutoGrant` | — | Tier 1 policy callback: `(agentScope, requestedScope) => boolean` |
| `approvalTimeoutMs` | 60000 | HITL approval timeout (ms) |
| `maxForwardDepth` | 5 | Maximum bubble-up forwarding depth |
| `prefix` | `"delegation"` | Tool name prefix |
| `trustTier` | `"verified"` | Trust tier for the request tool |

---

## Testing

- **182 tests** in the delegation package (unit + integration + E2E + property-based)
- **Coverage**: >80% lines, functions, and statements
- Key test files:
  - `wait-for-response.test.ts` — timeout, abort, immediate delivery, non-matching messages
  - `tools/request.test.ts` — grant/deny/timeout flows, input validation
  - `capability-request-bridge.test.ts` — Tier 1 auto-grant, Tier 2 HITL, bubble-up, depth limits
  - `__tests__/capability-request-e2e.test.ts` — full multi-agent flows with mock mailbox routing

---

## References

- `@koi/core` — L0 types: `DelegationComponent`, `MailboxComponent`, `ApprovalHandler`
- `@koi/governance` — L3 governance stack wiring
- `@koi/permissions-nexus` — ReBAC bridge for Nexus permission grants
- `@koi/middleware-delegation-escalation` — Human escalation when all delegatees fail
