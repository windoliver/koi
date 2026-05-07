# Issue 1210: Restore `@koi/temporal` Durable Execution

## Goal

Restore the missing durable execution layer inside `@koi/temporal` so the package can host Koi agent workflows through Temporal, including:

- workflow definitions for durable agent execution
- activity implementations that run Koi turns
- gateway text streaming during activity execution
- child-spawn handling from workflow to child workflow
- public exports that do not leak `@temporalio/*` types

This work intentionally builds on the existing v2 package surface in `packages/exec/temporal` instead of copying archive v1 wholesale.

## Current State

The current v2 package already includes:

- Temporal-backed scheduler/client abstractions
- spawn ledger support
- health monitoring
- worker factory wiring
- Temporal error mapping

The main missing slice is the workflow and activity runtime that actually executes durable Koi turns. Archive v1 contains that missing shape in:

- `archive/v1/packages/exec/temporal/src/workflows/agent-workflow.ts`
- `archive/v1/packages/exec/temporal/src/workflows/signals.ts`
- `archive/v1/packages/exec/temporal/src/activities/agent-activity.ts`

## Scope

### In scope

- restore workflow-safe signal/query definitions
- restore internal workflow and activity types needed for durable turn execution
- restore a host-side activity factory that runs one Koi turn and streams text deltas
- restore a workflow definition that queues messages, calls the activity, supports graceful shutdown, and spawns child workflows when requested
- export the restored runtime surface from `packages/exec/temporal/src/index.ts`
- add or update unit and integration-oriented tests for the restored behavior

### Out of scope

- restoring every archive-v1 helper module that is not required for the workflow/activity path
- redesigning the package split or introducing a new Temporal workflow package
- broad runtime/session/task refactors outside the boundaries needed for this restoration
- changing existing scheduler semantics unless required to integrate with the restored workflow surface

## Design

### 1. Internal Types

Extend `packages/exec/temporal/src/types.ts` with the internal workflow/activity contracts needed by the restored runtime:

- `AgentTurnInput`
- `AgentTurnResult`
- `SpawnChildRequest`
- `WorkerWorkflowConfig`
- any gateway-stream frame or helper types that are part of the host-side activity boundary

Design constraints:

- keep all types serializable across Temporal boundaries
- keep public exports structural and Koi-centric
- do not expose Temporal SDK classes or utility types from package exports

`ScheduledInputPayload`, `IncomingMessage`, and `AgentWorkflowConfig` stay the boundary between the existing scheduler layer and the restored workflow/activity layer.

### 2. Workflow Sandbox Layer

Add:

- `packages/exec/temporal/src/workflows/signals.ts`
- `packages/exec/temporal/src/workflows/agent-workflow.ts`

Responsibilities of the workflow:

- accept initial message or initial message batch on startup
- maintain a lightweight in-workflow queue of pending messages
- expose shared signal names for live message delivery and shutdown
- expose query names for state refs, status, and pending-count inspection
- process queued messages one turn at a time through a proxied `runAgentTurn` activity
- update lightweight `AgentStateRefs` after each successful turn
- request child workflow creation when the activity returns `spawnChild`
- stop gracefully after shutdown once in-flight work is finished

Design constraints:

- workflow state must remain lightweight and serializable
- no direct host I/O or runtime assembly inside workflow code
- workflow code owns Temporal-specific constructs such as signals, queries, conditions, and child execution

### 3. Host Activity Layer

Add:

- `packages/exec/temporal/src/activities/agent-activity.ts`

Responsibilities of the activity:

- build or receive an `EngineInput` for the current turn
- obtain a cached Koi runtime using injected dependencies
- run one Koi turn through the runtime
- collect emitted `text_delta` chunks into final `ContentBlock[]`
- forward text deltas to a gateway sender when configured
- capture `spawn_requested` events and convert them into `SpawnChildRequest`
- heartbeat periodically during long-running turns
- map failures into Temporal application failures using existing error helpers

Dependency injection remains host-side so the activity stays testable without requiring the full runtime stack in every unit test.

### 4. Worker Wiring

Keep `packages/exec/temporal/src/worker-factory.ts` as the host-side worker entry point.

The worker factory continues to:

- dynamically import `@temporalio/worker`
- create the worker and connection
- receive `activities` and `workflowsPath` from the caller

This issue does not require the worker factory to assemble Koi runtime dependencies by itself. It only needs to support the restored workflow/activity surface cleanly.

### 5. Public API

Update `packages/exec/temporal/src/index.ts` to export:

- the activity factory and related structural types
- workflow signal/query names and result types
- any newly-restored internal contracts that are already intended to be part of the package surface

Public API rule:

- no `@temporalio/*` type leakage in exported declarations

### 6. Child Spawn Behavior

For the first restored pass, child spawning should preserve the v1 behavior model:

- the activity may emit one child spawn request for a turn
- the workflow receives that request and starts a child workflow with the supplied config
- child workflow startup must remain on the Temporal side of the boundary, not inside the activity

This keeps the durable parent-child relationship explicit in workflow history and avoids mixing orchestration with host execution.

### 7. Gateway Streaming

Gateway streaming is included in this pass.

Behavior:

- during activity execution, each `text_delta` is forwarded immediately through an injected sender when gateway configuration is present
- the final returned `blocks` still contain the complete assistant response accumulated from the streamed deltas
- no gateway coupling is introduced into workflow sandbox code; only the host activity handles streaming

## Testing Plan

Implementation follows TDD in small slices:

1. Add or update API-surface tests for restored exports.
2. Add activity tests for:
   - text delta accumulation
   - gateway streaming calls
   - spawn request capture
   - error mapping to Temporal application failure payloads
3. Add workflow tests for:
   - initial message processing
   - signal-driven message queueing
   - shutdown behavior
   - child workflow spawn path
4. Keep or extend real Temporal integration tests only where they validate the restored boundary, not every internal branch.

Minimum success criteria:

- restored files compile
- unit tests prove the workflow/activity behavior
- package exports remain free of Temporal SDK type leakage

## Risks and Mitigations

### Risk: archive-v1 assumptions no longer match v2 seams

Mitigation:

- treat archive v1 as behavior reference, not copy source
- adapt runtime inputs to current `@koi/core` and existing v2 temporal types

### Risk: public API leaks Temporal SDK types

Mitigation:

- keep workflow SDK imports confined to workflow files
- use structural public types and existing anti-leak conventions in `index.ts` and `worker-factory.ts`
- verify generated declaration surface through focused tests or inspection

### Risk: child spawning couples orchestration and execution too tightly

Mitigation:

- keep spawn detection in the activity
- keep child workflow creation in the workflow
- pass only serializable spawn config across the boundary

### Risk: restored workflow work expands into unrelated runtime refactors

Mitigation:

- limit changes to `packages/exec/temporal` and only the immediate adjacent seams required to compile and test the restored surface

## Implementation Notes

- Primary workspace: `/Users/sophiawj/private/koi/.worktrees/issue-1210-temporal`
- Reference archive: `/Users/sophiawj/private/koi/archive/v1/packages/exec/temporal`
- Additional reference: `/Users/sophiawj/private/claude-code-source-code`

## Acceptance Criteria

- `@koi/temporal` exposes a restored workflow/activity runtime surface alongside the existing scheduler and worker utilities
- durable agent workflow logic exists in current v2 sources, not only in archive
- gateway streaming and child-spawn handling are included in the restored path
- tests cover the restored behavior
- exported package types remain free of `@temporalio/*` leakage
