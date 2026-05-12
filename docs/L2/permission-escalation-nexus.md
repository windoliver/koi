# @koi/permission-escalation-nexus

**Layer:** L2
**Package:** `packages/security/permission-escalation-nexus`
**Issue:** #1526

Nexus-backed transport for the L0 `PermissionEscalation` contract. Lets
isolated workers request runtime permission grants from a coordinator over
the Nexus mailbox, with the same typed `EscalationRequest` →
`EscalationDecision` flow as the in-process backing in
`@koi/permission-escalation-local` (#1241).

## Design: typed request/decision over a persisted mailbox

Worker calls `escalation.request(req)`:

1. **Pre-list** the worker's own inbox for an existing matching decision
   (reconnect-safe resume).
2. If a decision is already there and its `requestFingerprint` matches the
   current request payload, return it immediately — zero new sends.
3. Otherwise, send an `escalation_request` envelope to the coordinator's
   mailbox, then poll the worker's inbox until a fingerprint-matching
   decision arrives or the worker-declared `expiresAt` elapses
   (fail-closed → `expired`).

Coordinator's `pollOnce(resolver)`:

1. Lists own mailbox for `escalation_request` envelopes.
2. For each, validates routing (`from`/`to`/`workerAgentId`) and dedups on
   `(workerAgentId, requestId, fingerprint)` — a mutated retry of the same
   id reaches the resolver again; a colliding id from a different worker is
   not conflated.
3. Calls `resolver(record.request)`. If the request expired before/during
   resolve, the coordinator emits an `expired` decision instead.
4. Sends an `escalation_decision` envelope to the worker, embedding the
   canonical `requestFingerprint` so the worker can verify the decision
   binds to *this* request payload.

## API

```typescript
import {
  createNexusPermissionEscalation,
  createNexusPermissionEscalationCoordinator,
} from "@koi/permission-escalation-nexus";
import { createHttpTransport } from "@koi/nexus-client";

const transport = createHttpTransport({ url: "http://nexus:3100" });

// Worker side — implements L0 PermissionEscalation
const escalation = createNexusPermissionEscalation({
  transport,
  agentId: "agent:worker" as AgentId,
  coordinatorAgentId: "agent:leader" as AgentId,
  pollIntervalMs: 250,
});

const decision = await escalation.request({
  requestId: "req-1",
  agentId: "agent:worker" as AgentId,
  requestedGrants: ["fs:write"],
  purposeStatement: "patch a file the user authorized in the prompt",
  expiresAt: Date.now() + 30_000,
});

// Coordinator side — driven by host (e.g. TUI approval handler)
const coordinator = createNexusPermissionEscalationCoordinator({
  transport,
  coordinatorAgentId: "agent:leader" as AgentId,
});
setInterval(() => {
  void coordinator.pollOnce(async (req) => {
    const approved = await askHumanForApproval(req);
    return approved
      ? { decision: "approved", grantedGrants: req.requestedGrants }
      : { decision: "rejected", reason: "human declined" };
  });
}, 250);
```

## Security properties

| Property | Mechanism |
|----------|-----------|
| Fail-closed on timeout | Worker's polling loop returns `expired` once `clock() >= expiresAt`; coordinator returns `expired` if request expires mid-resolve. No silent grant. |
| Fail-closed on transport error | Worker maps any `ipc.list`/`ipc.send` error to `rejected` with the underlying message; never returns `approved` on an error path. |
| Bound identity | Worker rejects any `request()` whose `agentId` differs from the configured `agentId` before any I/O — prevents callers from impersonating peers via the same client. |
| Routing validation | Worker only accepts decisions where `from === coordinatorAgentId`, `to === agentId`, and the payload's `workerAgentId`/`coordinatorAgentId` match. Stale or forged messages from other agents are filtered. |
| Replay protection | Decision records carry a canonical `requestFingerprint` (sorted grants + purpose + expiresAt + context). Worker only replays a persisted decision when the current request produces the same fingerprint — requestId reuse with mutated purpose/grants does not inherit a stale approval. |
| Coordinator dedup | Keyed on `(workerAgentId, requestId, fingerprint)` so a mutated retry is reprocessed and two workers using the same `requestId` get independent decisions. |
| No re-delegation amplification | The L0 contract carries only `requestedGrants` — implementations cannot self-amplify scope. |

## Wiring

This package is `koi.optional: true`. The CLI (`packages/meta/cli`) selects
the nexus transport when `permissionEscalation.mode === "nexus"` is passed
to `createKoiRuntime` along with a configured `nexusTransport`. Otherwise
the local in-process backing from `@koi/permission-escalation-local` is
used (default).

The TUI host drives `pollPermissionEscalationCoordinator` from a
lifecycle-managed timer that routes incoming worker requests through the
existing approval handler — the same UX as in-process escalation.

## Out of scope

- The L0 `PermissionEscalation` contract itself (`packages/kernel/core/src/permission-escalation.ts`)
- The in-process backing (`@koi/permission-escalation-local`, #1241)
- Generic Nexus IPC mailbox semantics (`@koi/ipc-nexus`, #1373)

## Tests

| Layer | File | Coverage |
|-------|------|----------|
| L1 unit (mocked) | `src/*.test.ts` | worker/coordinator transport logic, validation, fail-closed paths |
| L1 integration | `src/__tests__/integration.test.ts` | happy/deny/expiry/throw, reconnect resume, replay-with-mutation, forged sender, cross-worker collision, multi-poll dedup, transport errors, coord-side post-resolve expiry |
| L2 two-process e2e | `src/__tests__/two-process.test.ts` | real HTTP transport across child Bun procs: cross-process happy/deny, no-coord timeout, daemon-down fail-closed |
| L3 manual smoke | `MANUAL-SMOKE.md` | two-pane TUI procedure for operators (LLM keys + Nexus daemon required) |
