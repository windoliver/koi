# Autonomous Composition Notes

This document tracks the lower-layer pieces that power autonomous execution in v2.

The public package is [`@koi/autonomous`](../L3/autonomous.md), but the behavior it composes lives below L3:

- `@koi/task-spawn`
  - `reconcileTaskBoard(snapshot)` determines ready dispatches and stale-delegation recovery actions.
  - `createSpawnFitnessWrapper(spawn, config)` records spawn outcomes without changing caller-visible behavior.
  - `createTaskSpawnProvider(config)` exposes the `task` tool through standard provider assembly.
- `@koi/long-running`
  - `sendWithRetry(send, message, options)` handles best-effort notification delivery with transient retry policy.
  - `createCompletionNotifier(config)` formats completion/failure messages and routes them through the retry helper.

## Current Layer Split

- L2 owns autonomous behavior and policy.
- L3 owns assembly only.
- `@koi/autonomous` should stay small: cached middleware, optional provider assembly, and ordered disposal.

## Current Composition Path

`createAutonomousAgent(parts)` builds a runtime handle from pre-constructed dependencies:

- required `harness`
- required `scheduler`
- optional `agentResolver`
- optional `spawn`
- optional `spawnFitness`
- optional `completionNotifier`
- optional extra middleware

If both `spawn` and `agentResolver` are present, the facade exposes a cached `providers()` array containing the task-spawn provider. If `spawnFitness` is also present, the provider uses the wrapped spawn hook so outcome recording happens through the normal `task` tool path.

## Why This Split Exists

The issue restoring `@koi/autonomous` deliberately avoided reintroducing a fat L3 package.

- Reconciliation logic is easier to test in `@koi/task-spawn`.
- Notification delivery is easier to test in `@koi/long-running`.
- The facade can stay dependency-injected and layer-clean.

## Source Of Truth

- Public package doc: [`docs/L3/autonomous.md`](../L3/autonomous.md)
- Facade implementation: [`packages/meta/autonomous/src/autonomous.ts`](/Users/sophiawj/.codex/worktrees/994c/koi/packages/meta/autonomous/src/autonomous.ts:1)
- Task-spawn helpers: [`packages/lib/task-spawn/src`](/Users/sophiawj/.codex/worktrees/994c/koi/packages/lib/task-spawn/src)
- Long-running helpers: [`packages/lib/long-running/src`](/Users/sophiawj/.codex/worktrees/994c/koi/packages/lib/long-running/src)
