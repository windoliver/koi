# @koi/swarm

Team swarm coordination over same-node IPC with an optional cross-node federation bridge.

## Purpose

`@koi/swarm` is the Phase 4g-2 coordination surface for teams. It keeps team
membership, task assignment, progress, abort, and cross-team delegation in a
small L2 package that composes existing lower surfaces instead of adding new
kernel behavior.

## Architecture

- Local teams use injected `MailboxComponent` instances for assignment and
  abort messages. Hosts commonly provide `@koi/ipc-local` mailboxes for
  same-node teams.
- Remote teams use an injected federation bridge, shaped to be backed by
  `@koi/federation` without making federation a required runtime dependency.
- `@koi/team-runtime` remains the team-role and runtime layer; `@koi/swarm`
  focuses on live coordination between those roles.
- Task selection is deterministic and supports `round-robin`, `capability`, and
  `load` strategies.
- Progress and assignment snapshots are returned as detached values so callers
  cannot mutate coordinator state.

## Main API

```ts
import { createSwarmCoordinator } from "@koi/swarm";

const coordinator = createSwarmCoordinator({
  localZoneId,
  federation,
});

coordinator.registerTeam({
  teamId: "alpha",
  leadAgentId,
  zoneId: localZoneId,
  leadMailbox,
});
coordinator.registerMember({
  teamId: "alpha",
  agentId: workerId,
  capabilities: ["code", "test"],
  mailbox: workerMailbox,
});

await coordinator.distributeTask(
  "alpha",
  {
    id: "task-1",
    subject: "Review auth flow",
    description: "Check the auth flow for regressions",
    requiredCapabilities: ["code"],
  },
  { strategy: "capability" },
);
```

## Federation

Federation is optional. A coordinator without `federation` still supports all
local teams. Remote-team assignment returns a structured failure instead of
throwing, which lets hosts stay local-only until they explicitly wire a
federation bridge.

## Testing

The package tests cover the issue #1418 acceptance cases:

- same-node task assignment through IPC
- cross-node assignment through the optional federation bridge
- round-robin, capability, and load distribution
- progress tracking by teammate
- team-wide abort
- cross-team delegation
- missing-federation local-only fallback
