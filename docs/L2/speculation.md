# @koi/speculation

Speculative fork execution coordinator for hosts that want to pre-compute a likely next agent response before the user explicitly accepts it.

The package is an opt-in L2 helper. It does not run an engine, create worktrees, or render UI itself. Hosts inject three collaborators:

- `forkAgent` runs the speculative child agent.
- `overlayManager` creates, accepts, and rejects isolated workspace overlays.
- `presentResult` displays a completed speculative result to the host UI.

This keeps the coordinator independent from `@koi/engine`, `@koi/workspace`, and `@koi/tui` while still giving those packages a shared lifecycle contract.

## Public API

```ts
import { createSpeculationController } from "@koi/speculation";

const controller = createSpeculationController({
  overlayManager,
  forkAgent,
  presentResult,
  maxConcurrent: 1,
  timeoutMs: 30_000,
});
```

### `start(request)`

Creates an overlay and starts speculative fork execution in the background.

Returns:

- `{ kind: "started", id, overlay }` when speculation was admitted.
- `{ kind: "fallback", reason, error? }` when normal execution should continue without speculation.

The request includes `description`, `agentName`, and an optional `spawnRequest` payload for hosts that adapt from the L0 `SpawnRequest` contract.

### `accept(id)`

Aborts the speculative fork if it is still running, asks the overlay manager to merge the overlay, removes the active speculation, and returns the changed paths.

Accept failures return a fallback response rather than throwing.

### `reject(id)`

Aborts the speculative fork if it is still running, rejects the overlay, and removes the active speculation.

Reject failures return a fallback response rather than throwing.

### `cancelAll(reason)`

Cancels all active speculation and rejects their overlays. Hosts should call this when new user input arrives so old predictions cannot race the new turn.

## Failure Model

Speculation is best-effort. Overlay creation failures, fork failures, presentation failures, timeouts, and resource-limit refusals all resolve to fallback states so the caller can continue normal execution.

The controller does not persist transcript state and does not mutate the real workspace directly. Real workspace changes happen only through the injected `overlayManager.accept(id)` implementation.

## Overlay Integration

Use `@koi/workspace` for the local git-worktree overlay implementation:

```ts
import { createGitWorktreeOverlayManager } from "@koi/workspace";

const overlayManager = createGitWorktreeOverlayManager({ repoPath });
```

Future hosts can provide Nexus-backed or sandbox-backed overlay managers as long as they implement the same `create` / `accept` / `reject` shape.

## UI Integration

`presentResult` is the accept/reject UI seam. Terminal or app hosts should render the speculative output and call `accept(id)` or `reject(id)` from their own input handlers.

The package intentionally does not define keybindings, modal layout, or transcript injection. Those are host-level concerns because TUI, daemon, and remote sessions have different interaction models.
