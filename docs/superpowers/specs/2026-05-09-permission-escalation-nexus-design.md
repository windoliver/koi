# Design: `@koi/permission-escalation-nexus` — Nexus-Backed Coordinator→Worker Permission Escalation

**Date:** 2026-05-09
**Issue:** [#1526](https://github.com/windoliver/koi/issues/1526)
**Approach:** B — transport swap with runtime/TUI assembly wiring

---

## Overview

Adds a Nexus-backed implementation of the existing L0 `PermissionEscalation`
contract so isolated workers can request runtime grant escalation from a
coordinator across process and worktree boundaries.

This issue is a transport swap, not a permission-system redesign:

- Keep the L0 contract in
  `packages/kernel/core/src/permission-escalation.ts`
- Keep the existing coordinator-facing approval UI and in-process approval
  behavior
- Add a new Nexus transport package that persists escalation requests and
  decisions
- Wire runtime assembly so workers use the local implementation when
  co-located and the Nexus implementation when coordinator/worker communication
  crosses an isolation boundary

The system must fail closed. Transport errors, malformed records, auth/authz
failures, and coordinator unavailability all resolve to deny-style outcomes,
never implicit approval.

---

## Goals

1. Implement `@koi/permission-escalation-nexus` as an L2 transport package for
   the existing `PermissionEscalation` interface.
2. Persist pending escalation requests in Nexus so they survive transient worker
   disconnects and reconnects within TTL.
3. Let a coordinator consume Nexus-backed escalation requests and resolve them
   through the same approval surface already used for local prompts.
4. Wire runtime/TUI assembly so the transport choice is made at composition
   time: local for in-process coordination, Nexus for isolated workers.
5. Preserve fail-closed semantics across all timeout and transport error paths.

## Non-Goals

- Changing the L0 `PermissionEscalation` shape
- Redesigning the permission middleware or approval UI
- Replacing the existing in-process escalation implementation
- Building a generic new Nexus RPC framework beyond what `ipc-nexus` already
  provides

---

## Package Structure

| Package | Layer | Purpose |
|---------|-------|---------|
| `@koi/permission-escalation-nexus` | L2 | Nexus-backed `PermissionEscalation` transport implementation |
| `packages/meta/cli/src/runtime-factory.ts` | L3 assembly | Select local vs Nexus escalation implementation |
| `@koi/ui/tui` / CLI assembly | L3 | Route remote escalation requests into the existing approval handler |

### New Package: `@koi/permission-escalation-nexus`

Suggested path:
`packages/security/permission-escalation-nexus`

Exports:

```typescript
import type {
  KoiError,
  PermissionDecision,
  PermissionEscalation,
  PermissionRequest,
  Result,
} from "@koi/core";
import type { NexusTransport } from "@koi/nexus-client";

export interface NexusPermissionEscalationConfig {
  readonly transport: NexusTransport;
  readonly workerAgentId: string;
  readonly coordinatorAgentId: string;
  readonly requestChannel?: string;
  readonly decisionChannel?: string;
  readonly pollIntervalMs?: number;
  readonly clock?: () => number;
}

export interface NexusPermissionEscalationCoordinatorConfig {
  readonly transport: NexusTransport;
  readonly coordinatorAgentId: string;
  readonly requestChannel?: string;
  readonly decisionChannel?: string;
  readonly pollIntervalMs?: number;
  readonly clock?: () => number;
}

export interface NexusPermissionEscalationCoordinator {
  readonly pollOnce: (
    resolve: (request: PermissionRequest) => Promise<PermissionDecision>,
  ) => Promise<number>;
  readonly dispose: () => void;
}

export function createNexusPermissionEscalation(
  config: NexusPermissionEscalationConfig,
): PermissionEscalation;

export function createNexusPermissionEscalationCoordinator(
  config: NexusPermissionEscalationCoordinatorConfig,
): NexusPermissionEscalationCoordinator;

export function validatePermissionEscalationRequest(raw: unknown): Result<PermissionRequest, KoiError>;
export function validatePermissionEscalationDecision(raw: unknown): Result<PermissionDecision, KoiError>;
```

The exact helper names may vary, but the package needs two responsibilities:

- worker-side `PermissionEscalation.request(req)`
- coordinator-side polling/consumption loop that turns Nexus records into
  approval callbacks and writes back decisions

---

## Architecture

### Design Principle: persisted transport, in-memory waiters

The worker-facing API stays:

```typescript
await escalation.request(req);
```

But the source of truth moves from an in-memory resolver map to persisted Nexus
records:

1. Worker writes a request record keyed by `requestId`
2. Coordinator reads pending requests from Nexus
3. Coordinator resolves the request via the existing approval path
4. Coordinator writes a decision record for the same `requestId`
5. Worker polls for the matching decision record and resolves its local Promise

The worker may keep an in-memory Promise waiter for ergonomics, but recovery
must come from Nexus state, not from a process-local callback that disappears on
disconnect.

### Why not redesign approvals?

The current TUI and in-process bridge already encode queueing, user-facing
approval UX, and fail-closed behavior for local prompts. Reusing that approval
surface avoids parallel approval systems and keeps this issue scoped to
transport and assembly.

---

## Message Model

Use typed request/decision envelopes derived directly from the L0 contract.
Nexus persistence may wrap them in a mailbox-style envelope, but the payload
must stay close to the L0 types.

### Request record

```typescript
interface PermissionEscalationRequestRecord {
  readonly kind: "permission_escalation_request";
  readonly request: PermissionRequest;
  readonly workerAgentId: string;
  readonly coordinatorAgentId: string;
  readonly createdAt: number;
  readonly expiresAt: number;
}
```

### Decision record

```typescript
interface PermissionEscalationDecisionRecord {
  readonly kind: "permission_escalation_decision";
  readonly requestId: string;
  readonly workerAgentId: string;
  readonly coordinatorAgentId: string;
  readonly decision: PermissionDecision;
  readonly resolvedAt: number;
}
```

### Correlation

- `request.requestId` is the primary correlation key
- `workerAgentId` and `coordinatorAgentId` scope messages to the intended pair
- A coordinator must never resolve a request for a different coordinator ID
- A worker must ignore decisions that do not match its own `workerAgentId` and
  the original `requestId`

This mirrors the existing mailbox and worker-channel patterns already used in
Koi: discriminated message kinds plus explicit correlation IDs.

---

## Nexus Storage And Delivery

Use the `ipc-nexus` / mailbox adapter style rather than inventing a new
transport layer. The implementation can be backed by two logical channels:

- request channel: worker → coordinator
- decision channel: coordinator → worker

Suggested storage semantics:

- request records persist until resolved or expired
- decision records persist long enough for a reconnecting worker to observe
  them, then may be acknowledged or age out by TTL
- duplicate request writes for the same `requestId` are idempotent
- duplicate decision writes for the same `requestId` are ignored after the first
  terminal decision

The exact Nexus path layout can follow package conventions, for example:

```text
koi/permission-escalation/requests/<coordinatorAgentId>/<requestId>.json
koi/permission-escalation/decisions/<workerAgentId>/<requestId>.json
```

If `ipc-nexus` already provides a better mailbox abstraction for this, use that
instead of direct path management. The important contract is persistence,
correlation, and replay-on-reconnect within TTL.

---

## Worker Flow

Worker-side `request(req)` behavior:

1. Validate the request shape
2. Fail immediately with `expired` if `req.expiresAt <= now`
3. Write the request record to Nexus
4. Poll the decision channel for the matching `requestId`
5. If a valid decision arrives before TTL, resolve with it
6. If TTL elapses first, resolve fail-closed with:
   `{ decision: "expired", reason: "permission escalation timed out" }`
7. If Nexus read/write/auth fails at any point, resolve fail-closed with:
   `{ decision: "rejected", reason: "<transport failure reason>" }`

### Reconnect semantics

If the worker process restarts or reconnects before TTL:

- it may reissue `request(req)` with the same `requestId`
- the implementation must treat that as resume/idempotent behavior, not as a
  brand-new escalation
- it should check whether a decision already exists before waiting for new
  updates

This is the key reason pending requests must live in Nexus rather than only in
memory.

---

## Coordinator Flow

Coordinator-side behavior:

1. Poll or subscribe for pending request records addressed to the coordinator
2. Reject malformed or expired requests without calling the approval handler
3. Route valid requests into the existing approval path
4. Convert the approval outcome into a typed `PermissionDecision`
5. Write the decision record back to Nexus
6. Mark the request handled so it is not re-processed indefinitely

### Approval routing

The coordinator must reuse the current approval handler path rather than
building a second UI:

- local requests continue through the existing local bridge
- remote Nexus requests are adapted into the same approval handler callback
- the approver sees a single coherent approval experience

This is especially important in the TUI, where prompt queueing and timeout
behavior are already implemented and tested.

---

## Runtime And TUI Wiring

### Composition seam

All execution sites should depend on `PermissionEscalation` as an injected
capability rather than constructing the transport directly.

Assembly chooses the implementation:

- `local`: coordinator and worker are in the same process or otherwise share the
  in-process bridge safely
- `nexus`: worker is isolated and has a Nexus route to the coordinator

### Worker assembly

Where a worker runtime currently assumes approvals are local, replace that
assumption with injected `PermissionEscalation`. The worker should not know
whether it is talking to an in-memory resolver or a Nexus transport.

### Coordinator assembly

Add a coordinator-side Nexus escalation loop to the runtime/TUI assembly:

- create the coordinator consumer when Nexus worker coordination is enabled
- route incoming escalation requests into the existing approval handler
- publish the resolved decision back through Nexus

### Fallback rules

Allowed:

- explicit local implementation when the worker is truly co-located with the
  coordinator

Not allowed:

- silently downgrading a remote worker to local escalation because Nexus setup
  is missing
- any permissive fallback on Nexus auth/authz or transport failure

Remote escalation configuration errors must fail closed.

---

## Error Handling

| Scenario | Behavior |
|----------|----------|
| Request already expired before send | Return `expired` immediately |
| Worker cannot write request to Nexus | Return `rejected` with transport/auth reason |
| Coordinator reads malformed request | Write fail-closed `rejected` decision if possible; otherwise drop + log |
| Coordinator sees expired request | Write `expired` decision |
| Approval handler throws | Convert to `rejected`; never leave request hanging |
| Coordinator unavailable until TTL | Worker returns `expired` |
| Worker cannot read decision due to Nexus failure | Return `rejected` fail-closed |
| Decision payload malformed | Treat as `rejected` fail-closed |
| Duplicate request delivery | Handle idempotently by `requestId` |
| Duplicate decision delivery | First terminal decision wins |

Auth/authz note: if Nexus rejects access to either request or decision paths,
that is a deny-style outcome. Never retry forever and never assume success.

---

## Testing

### Package unit tests: `@koi/permission-escalation-nexus`

1. Worker request is written to the coordinator request channel
2. Coordinator consumes a valid request and writes a matching decision
3. Worker receives an approved decision and resolves the Promise
4. Worker receives a rejected decision and resolves the Promise
5. Request with past `expiresAt` returns `expired` without transport writes
6. Worker times out waiting for coordinator and returns `expired`
7. Duplicate `requestId` resumes rather than creating conflicting requests
8. Malformed decision payload fails closed as `rejected`
9. Nexus transport write failure fails closed as `rejected`
10. Nexus transport read failure fails closed as `rejected`

### Contract/integration tests

1. Worker request delivered to coordinator over Nexus gateway
2. Coordinator resolution propagated back to blocked worker Promise
3. Pending request survives worker reconnect within TTL
4. Leader unreachable causes deny-by-default / fail-closed outcome
5. Local and Nexus implementations satisfy the same `PermissionEscalation`
   contract expectations

### Assembly tests

1. Local assembly still selects the in-process implementation
2. Isolated worker assembly selects the Nexus implementation
3. Coordinator/TUI assembly routes remote requests through the existing approval
   handler
4. Remote approval decisions appear in the same queue/handler path as local
   approvals
5. Misconfigured Nexus remote mode fails closed rather than silently falling
   back to local

---

## Implementation Notes

### Files likely involved

- `packages/kernel/core/src/permission-escalation.ts`
  - no contract changes expected beyond documentation updates if assembly notes need tightening
- `packages/security/permission-escalation-nexus/*`
  - new package
- `packages/lib/ipc-nexus/src/*`
  - possible reuse/helper extension for mailbox-style delivery
- runtime assembly files under `packages/meta/cli`
  - `runtime-factory.ts` selects the implementation and starts the coordinator consumer
- CLI/TUI startup files under `packages/meta/cli`
  - `tui-command.ts` threads the approval handler and lifecycle cleanup through the coordinator consumer
- TUI bridge/worker assembly files under `packages/ui/tui`
  - `permission-bridge.ts` and `engine-channel.ts` remain the coordinator-facing approval path remote requests feed into

### Reference patterns

- Current L0 contract:
  `packages/kernel/core/src/permission-escalation.ts`
- Existing local approval bridge:
  `packages/ui/tui/src/bridge/permission-bridge.ts`
- Worker↔main approval relay:
  `packages/ui/tui/src/worker/engine-channel.ts`
- Nexus mailbox/message patterns:
  `packages/lib/ipc-nexus/src/*`
- Historical inspiration only, not literal architecture:
  `/Users/sophiawj/private/claude-code-source-code/src/utils/swarm/leaderPermissionBridge.ts`
  `/Users/sophiawj/private/claude-code-source-code/src/utils/swarm/permissionSync.ts`

The Claude Code references are useful for the request/response shape and queue
intent, but Koi should avoid file-polling architecture and instead use the
typed Nexus messaging substrate already present in the repo.

---

## Open Decisions Resolved In This Spec

- Runtime wiring is in scope for `#1526`
- Transport choice happens at assembly, not in the L0 contract
- Coordinator approval UX is reused, not redesigned
- Pending requests persist in Nexus and survive reconnect within TTL
- All transport and auth failures are fail-closed

---

## Recommended Implementation Approach

Implement this in two layers within the same branch:

1. Build and test the standalone `@koi/permission-escalation-nexus` package
2. Wire runtime/TUI assembly to select and host it in isolated worker mode

That keeps the transport reusable and testable while still landing the
user-visible feature in the same issue.
