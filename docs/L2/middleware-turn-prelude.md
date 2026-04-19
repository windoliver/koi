# `@koi/middleware-turn-prelude` (L2)

Injects reactive background-task notifications as a **user-role** message prefix before each model turn.

## Non-goals

- Raw subprocess bytes are never injected. Agents call `task_output(taskId, { matches_only: true })` to read matched lines.
- This middleware does not own the `PendingMatchStore` — it is passed via `getStore()` from the CLI execution preset so it tracks session resets.

## Composition order

Turn-prelude MUST sort **outside** any middleware that rewrites `request` on retry (notably `@koi/middleware-semantic-retry`). It declares `phase: "resolve"` with `priority: 200` — strictly less than semantic-retry (420) and task-anchor (345). The assembled-runtime ordering invariant is tested in PR 3b's `bash-background-watch` golden query.

## Retry safety

- `peek(request)` is non-destructive and cached by `request` object identity.
- `ack(request)` fires on success:
  - For `wrapModelCall`: after `next()` resolves.
  - For `wrapModelStream`: the moment a terminal `{ kind: "done" }` chunk is observed, BEFORE yielding it downstream (`consume-stream.ts` tears the generator down on `done`).
- On error / abort, `ack` is skipped and matches remain pending for the next turn.

## Reset safety

`getStore: () => PendingMatchStoreRef.current` is resolved lazily on every invocation. The execution preset rotates the store in `onResetSession`; the middleware instance is reused but always reads the current store.
