# Temporal Workflows Design

**Date:** 2026-05-08
**Issue:** `#1356`
**Scope:** `packages/exec/temporal`

## Goal

Implement the Phase 3 Temporal workflow layer for Koi with:
- Koi-specific durable workflow definitions
- Activity implementations that wrap Koi operations
- Public workflow input/output types that do not leak `@temporalio/*`
- Recoverable workflow state for crash/restart scenarios
- Durable retry orchestration for transient failures

This work should complete the missing workflow/activity slice on top of the existing `@koi/temporal` scheduler, spawn-ledger, health, and worker-factory foundations.

## Non-Goals

- Reintroducing the full archived v1 engine-cache, delegation, or embed-mode surface
- Expanding `@koi/core` contracts beyond what is required for the workflow boundary
- Building a full production engine adapter inside this package
- Adding public Temporal SDK types to any exported API

## Current State

`packages/exec/temporal` already provides:
- `createTemporalScheduler(...)` for task submission, schedule management, and durable local state persistence
- `createTemporalWorker(...)` for worker construction with dynamic `@temporalio/worker` loading
- `createTemporalSpawnLedger(...)`, health monitoring, and Temporal error mapping
- Public Koi-facing types in `src/types.ts` with an explicit anti-leak boundary

What is missing relative to issue `#1356`:
- No `src/workflows/` directory
- No `src/activities/` directory
- No workflow registration surface for worker startup
- No durable workflow definitions for agent execution, scheduled tasks, or retry orchestration

## Requirements

### Functional

The package must provide:
- A durable `agentWorkflow` for long-lived agent execution driven by signals or initial payloads
- A `scheduledTaskWorkflow` for scheduled spawn/dispatch executions
- A `retryWorkflow` for durable retry orchestration of transiently failing operations
- Activity factories that wrap Koi-facing operations without exposing Temporal SDK types publicly
- A worker registration surface that can register the workflow set and activities together

### Boundary

The public API must:
- Expose only Koi-facing data types and structural interfaces
- Keep `@temporalio/workflow` imports inside workflow modules only
- Keep `@temporalio/activity` imports inside activity modules only
- Avoid exporting Temporal SDK-specific error, client, activity, or workflow handle types

### Recovery

The workflow layer must:
- Persist only small, serializable workflow state
- Resume safely after a worker crash or restart
- Avoid depending on in-memory state for correctness
- Make retry state explicit and durable when workflow-level retries are required

## Proposed Architecture

### 1. Workflow Modules

Create `packages/exec/temporal/src/workflows/` with:

- `agent-workflow.ts`
  - Implements a long-lived, signal-driven workflow for a single agent
  - Maintains lightweight state such as queued inputs, retry bookkeeping, shutdown flag, and `AgentStateRefs`
  - Invokes activities for all nondeterministic work

- `scheduled-task-workflow.ts`
  - Handles a scheduled execution request
  - Supports two modes:
    - `spawn`: start a new durable agent execution with serialized initial input
    - `dispatch`: signal an existing durable agent workflow with serialized input
  - Keeps schedule-trigger logic explicit rather than embedding it in the scheduler alone

- `retry-workflow.ts`
  - Implements durable retry orchestration for operations that need workflow-visible retry state
  - Tracks attempt count, backoff progression, and terminal outcome in workflow state
  - Delegates the actual operation to an activity wrapper

- `signals.ts`
  - Defines workflow signal and query names shared by workflow and caller code
  - Exports only Koi-owned names and structural payload types

### 2. Activity Modules

Create `packages/exec/temporal/src/activities/` with:

- `agent-activity.ts`
  - Wraps one Koi agent turn
  - Accepts Koi-owned turn input
  - Returns Koi-owned turn result containing updated refs and workflow instructions

- `scheduled-task-activity.ts`
  - Wraps the Koi operation needed for a scheduled run when direct workflow handling is not deterministic
  - Converts a scheduled payload into the Koi execution call shape

- `retry-activity.ts`
  - Wraps a retryable Koi operation behind a structural dependency interface
  - Returns success/failure in a serializable Koi-owned result shape

Activities will be created through factories with injected dependencies so unit tests can use plain mocks without requiring a live Temporal runtime.

### 3. Worker Registration Surface

Extend the package with a worker-facing registration helper that assembles:
- workflow entry points
- activity functions
- workflow path resolution or workflow module export registration

This helper should build on `createTemporalWorker(...)` rather than replace it. The existing worker factory remains the low-level worker constructor; the new layer makes issue `#1356` usable without leaking SDK details into consumers.

### 4. Public Types

Expand `packages/exec/temporal/src/types.ts` with Koi-owned serializable types only:
- `AgentWorkflowConfig`
- `ScheduledSpawnArgs`
- scheduled-task workflow argument/result types
- retry workflow argument/result types
- activity result unions describing next workflow action

The public types should represent Koi semantics such as:
- “dispatch this input”
- “spawn a new execution”
- “retry after backoff”
- “complete with updated refs”

They must not represent Temporal semantics such as activity stubs, workflow handles, or SDK retry objects.

## Detailed Data Flow

### Agent Workflow

1. `createTemporalScheduler(...)` starts or signals the durable agent workflow.
2. `agentWorkflow(config)` receives:
   - `stateRefs`
   - optional initial input
   - optional initial queued inputs
3. The workflow stores only:
   - queued serialized inputs
   - lightweight `AgentStateRefs`
   - workflow-local retry counters
   - lifecycle flags
4. When input is ready, the workflow calls `runAgentTurn(...)` activity.
5. The activity performs the Koi-side operation and returns:
   - updated refs
   - completion status
   - optional next-step instruction
6. The workflow applies the result:
   - complete the turn
   - requeue input
   - trigger retry path
   - shut down if requested

### Scheduled Task Workflow

1. A schedule trigger starts `scheduledTaskWorkflow(...)`.
2. The workflow reads a Koi-owned `mode` field:
   - `spawn`
   - `dispatch`
3. For `spawn`, it starts a new agent workflow with serialized initial input.
4. For `dispatch`, it signals the stable agent workflow ID.
5. Any nondeterministic conversion or side-effectful preprocessing goes through an activity.

### Retry Workflow

1. A workflow or caller invokes `retryWorkflow(...)` with:
   - retryable operation input
   - max attempts
   - backoff policy represented in Koi-owned fields
2. The workflow calls `runRetriedOperation(...)` activity.
3. On transient failure, the workflow sleeps deterministically and retries.
4. On success, it returns a serializable success result.
5. On terminal failure, it returns a serializable terminal result or throws a mapped error, depending on the call site contract.

## Recovery Model

Workflow correctness must survive process crashes. To keep recovery predictable:

- Workflow state remains small and serializable
- Activities are the only place side effects occur
- Workflow-level retries record attempt state durably
- Agent workflow progress is reflected through `AgentStateRefs`, not in-memory engine objects
- Schedule-triggered executions derive everything needed from workflow args and persisted scheduler state

This gives the package two recovery layers:
- scheduler persistence and workflow identity at the submission layer
- workflow state and activity retries at the orchestration layer

## File Plan

### New Files

- `packages/exec/temporal/src/workflows/agent-workflow.ts`
- `packages/exec/temporal/src/workflows/scheduled-task-workflow.ts`
- `packages/exec/temporal/src/workflows/retry-workflow.ts`
- `packages/exec/temporal/src/workflows/signals.ts`
- `packages/exec/temporal/src/workflows/index.ts`
- `packages/exec/temporal/src/activities/agent-activity.ts`
- `packages/exec/temporal/src/activities/scheduled-task-activity.ts`
- `packages/exec/temporal/src/activities/retry-activity.ts`
- `packages/exec/temporal/src/activities/index.ts`
- `packages/exec/temporal/src/__tests__/workflows.test.ts`
- `packages/exec/temporal/src/__tests__/activities.test.ts`

### Modified Files

- `packages/exec/temporal/src/index.ts`
- `packages/exec/temporal/src/types.ts`
- `packages/exec/temporal/src/worker-factory.ts`
- `packages/exec/temporal/src/temporal-scheduler.ts`
- `docs/L2/temporal.md`

## Testing Strategy

### Workflow Tests

Add tests that verify:
- workflow entry points are exported and structurally registerable
- `agentWorkflow` drains initial input and responds to signal-driven input
- `agentWorkflow` preserves lightweight state across retry/re-entry logic
- `scheduledTaskWorkflow` distinguishes `spawn` and `dispatch`
- `retryWorkflow` retries transient failures and stops on terminal failure

### Activity Tests

Add tests that verify:
- agent activity adapts Koi input/output correctly
- scheduled-task activity converts payloads without Temporal leakage
- retry activity returns serializable outcomes for transient and terminal failures

### Boundary Tests

Add tests that verify:
- public exports do not require importing Temporal SDK types
- public type modules remain usable through structural typing alone

## Risks And Mitigations

### Risk: Reintroducing v1 baggage

The archived implementation contains more behavior than this issue requires.

Mitigation:
- Port only the workflow/activity patterns that are still relevant
- Keep delegation, engine cache, and embed-mode out unless a current API requires them

### Risk: Workflow state grows too large

Long-running workflows can drift toward storing too much state.

Mitigation:
- Keep workflow state limited to queued inputs, counters, flags, and `AgentStateRefs`
- Push all large mutable state behind Koi-owned external references

### Risk: Public API starts mirroring Temporal terminology

This would violate the adapter boundary requirement.

Mitigation:
- Review all new exports for Koi semantics first
- Keep Temporal-only concerns private to workflow/activity implementation files

## Rollout Notes

This work is designed as a minimal issue-complete slice. It intentionally does not attempt to recreate the full archived v1 orchestration stack. Once landed, the package will have:
- a real workflow layer
- real activity wrappers
- a clean registration surface
- durable retry orchestration
- crash-recoverable workflow state

That should satisfy the issue requirements while preserving the current v2 architecture and anti-leak constraints.
