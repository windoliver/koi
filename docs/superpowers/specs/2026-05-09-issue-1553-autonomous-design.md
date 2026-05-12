# `@koi/autonomous` Design for Issue #1553

## Summary

Issue [#1553](https://github.com/windoliver/koi/issues/1553) restores `@koi/autonomous` as the public entrypoint for long-running autonomous agent execution in v2.

The key design constraint is that current v2 layer rules treat L3 packages as composition facades, not homes for new runtime behavior. The implementation therefore keeps `@koi/autonomous` thin and moves new behavior into lower-layer helpers that can be tested independently and reused elsewhere.

This design uses the current v2 repository shape as ground truth, with `archive/v1/packages/meta/autonomous` as a reference rather than a direct port target.

## Goals

- Restore a public `createAutonomousAgent()` factory under `@koi/autonomous`
- Preserve L3 as an assembly/composition layer
- Reintroduce task-board-aware autonomous coordination in a way that is independently testable
- Support spawn-task reconciliation, completion notification, and spawn outcome feedback without coupling to L1
- Leave room for forge-backed agent resolution when the live v2 resolver package surface is available

## Non-Goals

- Do not recreate the entire v1 `@koi/autonomous` package verbatim
- Do not make `@koi/autonomous` an architectural exception to the L3 rules
- Do not introduce new L1 dependencies into L2 packages
- Do not block the package on missing or partially restored collaborators such as a live v2 `@koi/catalog`
- Do not restore old goal-stack auto-wiring as part of this issue unless the required v2 package already exists in the live tree

## Current Repository Reality

The current repo already contains:

- `@koi/long-running`
- `@koi/harness-scheduler`
- `@koi/task-board`
- `@koi/task-spawn`
- `@koi/forge-types`
- L3 composition packages such as `@koi/auto-harness` and `@koi/rlm-stack`

The current repo does not appear to contain a live v2 `@koi/autonomous` package or a live v2 `@koi/catalog` implementation matching the docs.

That means the design must:

- add a new `packages/meta/autonomous` package
- avoid hard runtime dependency on missing packages
- define extension points for resolver and spawn feedback behavior instead of assuming every v1 collaborator already exists

## Proposed Architecture

### 1. Public L3 Facade: `packages/meta/autonomous`

`@koi/autonomous` becomes a true meta-package with a narrow responsibility:

- expose `createAutonomousAgent(parts)`
- assemble middleware/providers/lifecycle helpers from lower-layer pieces
- own ordered disposal of scheduler before harness
- surface optional assembled capabilities such as `agentResolver`

This package may contain lightweight composition glue, but not the substantive business logic for reconciliation, retry policy, notification formatting, or fitness accounting.

### 2. Lower-Layer Behavior Modules

Behavior currently described in issue `#1553` is split into focused helpers:

- **Reconciler helper**
  - pure function over task-board snapshot/state
  - identifies dispatchable spawn tasks
  - handles stale delegation recovery rules
  - returns explicit actions instead of mutating harness state directly
- **Completion notifier helper**
  - translates task completion/failure/cancel events into outbound notifications
  - uses retryable send helper rather than embedding retry loops in the facade
- **Spawn fitness helper**
  - wraps a provided spawn function
  - records outcome signals through an injected recorder/store-facing interface
- **Resolver adapter hook**
  - optional adapter point for forge-backed resolver creation
  - lives behind an injected factory so missing v2 `@koi/catalog` does not block the package

These helpers should live in existing or new lower-layer packages based on responsibility, not all inside the L3 package.

## Package Boundaries

### `@koi/autonomous` (new L3)

Responsibilities:

- define the public facade types
- compose harness middleware with autonomous coordination hooks
- compose scheduler lifecycle with harness lifecycle
- wire optional helper modules together
- expose one disposal point and one middleware collection point

Likely files:

- `src/index.ts`
- `src/types.ts`
- `src/autonomous.ts`

### Reconciler module (new lower-layer helper)

Responsibilities:

- consume task-board snapshot or live board state
- determine ready work in topological order
- decide when delegated tasks should be retried, cleared, or cancelled
- bridge the task-board/task-spawn contract without depending on L1

Likely public API:

- `reconcileTaskBoard(input): ReconcileResult`

Key constraint:

- pure decision function first
- any side-effectful application of reconcile actions happens outside this helper

### Notification helper (new lower-layer helper)

Responsibilities:

- format autonomous lifecycle notifications
- distinguish completed vs failed vs cancelled cases
- send through an injected mailbox/notifier transport
- centralize retry/backoff policy for sends

Likely public API:

- `createCompletionNotifier(config)`
- `sendWithRetry(send, message, options)`

### Spawn fitness helper (new lower-layer helper)

Responsibilities:

- wrap the injected spawn function
- capture success/failure/duration
- report outcome using an injected recorder interface
- remain useful even if forge-backed selection is not fully restored yet

Likely public API:

- `createSpawnFitnessWrapper(spawn, config)`

## `createAutonomousAgent()` Shape

The public factory should accept already-constructed dependencies and return a composed runtime handle.

Expected input shape:

- required `harness`
- required `scheduler`
- optional `agentResolver`
- optional `spawn` or delegated spawn hook
- optional notifier transport/callbacks
- optional fitness recorder
- optional middleware to append to the autonomous stack
- optional resolver factory input for future forge-backed auto-resolution

Expected returned handle:

- `harness`
- `scheduler`
- `middleware()`
- `providers()` only if required by live lower-layer integrations
- `dispose()`
- optional `agentResolver`

The factory should not instantiate engine-specific runtime objects and should not import from L1.

## Reconciliation Model

The reconciler is the core behavior and should follow these rules:

1. Read task-board state as input.
2. Determine which tasks are dispatchable now.
3. Detect stale delegated state and emit recovery actions.
4. Prevent dispatch when upstream tasks failed or cancelled.
5. Preserve topological order for ready tasks.
6. Return a deterministic action list.

Recommended action model:

- `dispatch`
- `clearDelegation`
- `cancelDownstream`
- `recordFailure`
- `noop`

This is better than a monolithic bridge because it keeps the tricky policy logic unit-testable and lets the facade decide how to apply those actions against harness/task-spawn primitives.

## Missing-Collaborator Strategy

Two collaborators mentioned by the issue and docs are not clearly live in v2 today:

- `@koi/catalog`
- `@koi/goal-stack`

Design response:

- `@koi/autonomous` must not hard-require them for initial restoration
- resolver auto-creation should be behind an optional injected factory
- goal-stack auto-wiring is explicitly out of scope for this issue unless the package surface already exists in the live tree

This keeps `#1553` shippable without waiting for every v1-era dependency to be restored.

## Testing Strategy

### Unit tests

- reconciler keeps blocked tasks blocked
- reconciler emits ready tasks in topological order
- reconciler cancels downstream after upstream failure
- reconciler emits recovery action for stale delegated pending tasks
- notifier fires the correct callback/message for completed and failed states
- retry-send retries transient send failures and stops at configured limit
- spawn-fitness wrapper records success and failure outcomes correctly
- `createAutonomousAgent()` composes middleware in stable order
- `dispose()` stops scheduler before harness and is idempotent

### Integration tests

- autonomous facade wires harness + scheduler + reconciler helper together
- dispatchable task-board tasks flow through spawn hook and results are applied back to harness state
- optional resolver passes through when provided explicitly
- no optional collaborator means the package still constructs and runs in minimal mode

### Non-test goals

- preserve layer-check cleanliness
- preserve orphan checks
- keep API-surface tests for the new package stable once introduced

## Implementation Notes

- Follow the established v2 pattern used by `packages/meta/auto-harness` and `packages/meta/rlm-stack`
- Prefer adding lower-layer helpers in existing responsibility-aligned packages when possible
- Only add new packages when an existing package would become muddled by mixed responsibilities
- Use v1 autonomous files as behavioral references, not architectural truth
- Prefer dependency injection over implicit singleton resolution

## Risks

### Risk: L3 drift back into business logic

Mitigation:

- keep reconciler, notifier, and fitness behavior outside the facade
- review `packages/meta/autonomous` file sizes and imports aggressively

### Risk: unresolved resolver dependency

Mitigation:

- make forge-backed auto-resolution optional
- ship explicit `agentResolver` support first

### Risk: stale task delegation semantics are underspecified

Mitigation:

- encode stale-delegation recovery as explicit reconciler actions
- add tests based on the issue comment’s three recovery gaps

## Rollout Plan

Phase 1:

- introduce lower-layer helpers and tests
- introduce `packages/meta/autonomous`
- ship explicit dependency injection path only

Phase 2:

- add optional resolver factory integration once live v2 resolver package exists

Phase 3:

- evaluate restoring goal-stack-related conveniences only if the corresponding v2 packages are present and layer-safe

## Open Decisions Resolved

- `@koi/autonomous` remains L3 and thin
- business logic moves into lower-layer helpers
- missing v2 collaborators do not block the package
- v1 is a reference implementation, not the package layout to recreate

## Success Criteria

This issue is complete when:

- a new `@koi/autonomous` package exists in `packages/meta/autonomous`
- the package exposes a working `createAutonomousAgent()` facade
- autonomous behavior is restored through lower-layer helpers rather than L3 business logic
- the reconciler covers the stale delegation gaps called out on issue `#1553`
- tests prove composition, recovery, and lifecycle ordering behavior
