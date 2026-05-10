# `@koi/autonomous`

`@koi/autonomous` is the L3 facade for autonomous execution.

It composes:

- `@koi/long-running`
- `@koi/harness-scheduler`
- `@koi/task-spawn` autonomous helpers

The package intentionally keeps runtime behavior out of L3. The facade does
**not** invoke reconciliation or notification on its own — callers wire the
following lower-layer helpers into their scheduler/harness lifecycle:

- task-board reconciliation: `reconcileTaskBoard` in `@koi/task-spawn`
- spawn outcome tracking: `createSpawnFitnessWrapper` in `@koi/task-spawn`
- completion/failure notification: `createCompletionNotifier` in `@koi/long-running`

## Public Surface

`createAutonomousAgent(parts)` returns a thin runtime handle with:

- `harness`
- `scheduler`
- `middleware()`
- `providers()` when task-spawn wiring is configured
- `dispose()`
- optional `agentResolver`

## Composition Rules

- middleware ordering is stable and cached
- provider assembly is cached
- scheduler disposal happens before harness disposal
- repeated `dispose()` calls are safe

## Minimal Mode

The facade does not require optional collaborators such as forge-backed resolver creation or higher-level goal-stack wiring. When only `harness` and `scheduler` are provided, the package still constructs a valid autonomous handle.
