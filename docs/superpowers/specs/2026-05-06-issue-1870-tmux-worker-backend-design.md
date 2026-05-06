# Design: Issue 1870 tmux WorkerBackend + bg attach/detach wiring

## Summary

Implement a `tmux` `WorkerBackend` in `@koi/daemon` and wire `koi bg attach` / `koi bg detach` to use persisted tmux session metadata for true interactive reattachment. The backend must work both when Koi is already running inside tmux and when it is launched from a normal terminal, must honor the `WorkerBackend.watch(id, signal?)` abort contract, and must use worktree-prefixed tmux session names to avoid collisions across parallel worktrees.

## Goals

- Add `createTmuxBackend()` to `@koi/daemon` with `kind: "tmux"`.
- Spawn supervised workers into visible tmux panes.
- Persist enough tmux targeting metadata in the background session registry for cross-process CLI attach/detach.
- Upgrade `koi bg attach` from log-tail fallback to true tmux attach for `backendKind === "tmux"`.
- Upgrade `koi bg detach` from placeholder text to a real tmux detach flow.
- Keep subprocess behavior unchanged.

## Non-goals

- Implement the remote backend.
- Add heartbeat transport for tmux workers in this issue.
- Build a full multi-pane swarm layout manager like Claude Code.
- Add a generic backend RPC channel from `koi bg` to the live supervisor.

## Constraints

- `WorkerBackend.watch(id, signal?)` must return promptly when `signal` is aborted.
- tmux session names must be prefixed with the current worktree slug per [`CLAUDE.md`](/Users/sophiawj/.codex/worktrees/0cb9/koi/CLAUDE.md:500).
- `koi bg` commands are separate processes and only have registry access, so attach/detach cannot depend on backend in-memory state.
- Existing subprocess and registry semantics must remain backward compatible.

## Approach

### 1. New backend module

Add `packages/net/daemon/src/tmux-backend.ts` and export `createTmuxBackend()` from `packages/net/daemon/src/index.ts`.

The backend owns:

- tmux availability detection via `tmux -V`
- session naming and creation
- pane creation and teardown
- worker-to-pane state tracking inside the daemon process
- lifecycle event emission and replay
- polling-based watch semantics for pane closure, with abort-aware cancellation

### 2. Session model

Use one worktree-scoped tmux session for daemon workers:

- session name: `${WORKTREE}-daemon-workers`
- window strategy:
  - if already inside tmux, create a dedicated window in the current session when possible
  - if outside tmux, create or reuse a detached session named `${WORKTREE}-daemon-workers`
- pane strategy:
  - first worker creates the first pane in the daemon window
  - subsequent workers split the same window into additional panes

The backend does not need Claude Code’s full pane-coloring or leader-pane layout. It only needs deterministic pane creation, titles, and liveness tracking.

### 3. Persisted tmux target metadata

Extend the background session registry record with optional tmux attachment metadata so cross-process CLI commands can reconnect:

```ts
readonly tmuxSessionName?: string;
readonly tmuxWindowTarget?: string;
readonly tmuxPaneId?: string;
```

Add matching optional fields to `BackgroundSessionUpdate`.

Rules:

- present only for `backendKind === "tmux"`
- persisted at registration time or immediately after successful spawn
- updated on respawn if pane identity changes
- retained while status is `running` or `detached`
- left intact on `detached` so later `attach` can reconnect

### 4. Spawn behavior

`spawn(request)` will:

- validate non-empty `command`
- resolve the target tmux session/window
- create a pane with `tmux new-session`, `new-window`, or `split-window`
- set pane title to a human-readable worker label
- start the worker command in that pane
- query tmux for pane id and pane PID
- return a `WorkerHandle` with `backendKind: "tmux"`
- emit a `started` event with PID when available

Command execution should prefer `tmux send-keys` into a freshly created shell pane rather than relying on fragile inline quoting for a full spawned command. This mirrors the repo’s existing tmux test style and avoids shell-escaping bugs.

### 5. Terminate / kill / isAlive

`terminate(id, reason)`:

- send `C-c`
- optionally follow with `send-keys "exit"` if the pane stays alive briefly
- classify eventual exit as intentional

`kill(id)`:

- `tmux kill-pane -t <pane>`
- treat already-missing panes as idempotent success

`isAlive(id)`:

- consult cached worker state first
- confirm with tmux pane inspection (`list-panes` / `display-message`)
- false if pane is absent or marked dead

### 6. watch(id, signal?)

tmux has no native async lifecycle feed for this use case, so `watch()` will be implemented as a replay-plus-poll iterator:

- replay buffered `started` / terminal events to late subscribers
- while live, poll tmux pane state on a short interval
- when the pane disappears or becomes dead, emit terminal `exited` or `crashed`
- if `signal.aborted`, stop polling, clean up listeners/timers, and return immediately

This follows the existing subprocess backend contract shape without requiring a daemon-wide tmux socket listener.

### 7. Registry bridge updates

The existing `attachRegistry` bridge already handles PID refresh from `started` events and lifecycle state transitions. This issue adds persisted tmux target fields, but those are spawn-path facts rather than watch-path facts.

Design choice:

- keep tmux target persistence in the spawn/registration path, not in `attachRegistry`
- use `attachRegistry` only for lifecycle status updates

This keeps the bridge stateless and preserves its current responsibility boundaries.

### 8. CLI attach / detach wiring

Update `packages/meta/cli/src/commands/bg.ts`.

`koi bg attach <id>`:

- if `backendKind === "subprocess"`, keep current read-only log behavior
- if `backendKind === "tmux"`, require persisted tmux target metadata
- when already inside tmux, use `tmux switch-client` or `select-pane` / `select-window` to focus the worker target
- when outside tmux, use `tmux attach-session -t <session>`
- after a successful attach handoff, best-effort CAS-update the registry status to `running`

`koi bg detach`:

- for non-tmux backends, keep the current informational behavior
- for tmux-backed interactive sessions, call `tmux detach-client`
- best-effort CAS-update the registry entry for the attached worker to `detached`

Because `detach` is client-scoped and the CLI process may not always know the intended worker from tmux alone, the initial version will define a narrow contract:

- `bg attach` sets environment variables identifying the attached worker/session for the child attach process
- `bg detach` reads those variables when invoked from that attached client path

This keeps the first pass explicit and avoids overreaching into global tmux-session introspection heuristics.

## Data model changes

### `@koi/core`

Update `BackgroundSessionRecord` and `BackgroundSessionUpdate` with optional tmux fields:

- `tmuxSessionName?: string`
- `tmuxWindowTarget?: string`
- `tmuxPaneId?: string`

Validation rules:

- if any tmux field is present, `backendKind` must be `"tmux"`
- empty strings are invalid for tmux identifiers
- non-tmux records may omit all three fields

### Registry persistence

`packages/net/daemon/src/file-session-registry.ts` will accept and round-trip the new optional fields with backward compatibility for older records that lack them.

## Testing plan

### Unit tests

Add `packages/net/daemon/src/__tests__/tmux-backend.test.ts` covering:

- `isAvailable()` false when tmux is unavailable
- spawn creates a pane and reports `backendKind: "tmux"`
- terminate closes a long-running pane
- kill is idempotent
- multiple workers get distinct panes
- `watch()` exits when `AbortSignal` aborts mid-iteration

Extend registry validation tests for the new tmux fields.

Extend `bg` CLI tests for:

- tmux attach dispatch when registry metadata is present
- subprocess attach remains log-follow fallback
- detach remains informational for non-tmux backends

### Integration / E2E

Add opt-in tmux integration tests gated on environment availability:

- spawn worker and verify pane exists
- attach path can resolve session/pane metadata
- terminate leads to terminal watch event

These tests should follow the repo’s existing tmux-gated pattern and must not become required for default CI.

## Error handling

- Missing tmux binary: `isAvailable() === false`, supervisor returns `UNAVAILABLE` if tmux is explicitly requested.
- Pane/session creation failure: return `INTERNAL` or `UNAVAILABLE` with stderr details.
- Missing persisted tmux metadata on `bg attach`: fail with a clear operator message instead of silently tailing logs.
- `detach-client` outside tmux: return an operator-facing failure explaining that detach must run from an attached tmux client.

## Risks

### Cross-process attach state

The thinnest version of `bg detach` needs a reliable way to know which worker is currently attached. Passing worker/session identity through environment variables from the attach flow is the simplest first pass, but it is intentionally narrow and only covers the supported attach path.

### Poll-based watch

tmux pane liveness polling is less precise than subprocess exit promises. The design keeps polling intervals short and treats missing panes as terminal, which is acceptable for this backend because observability and operator attachability matter more than millisecond-accurate exit timestamps.

### Quoting and command injection

Sending commands through tmux shells can be quoting-sensitive. Using literal `send-keys` segments and avoiding large one-shot shell strings reduces this risk.

## Implementation sketch

1. Extend `@koi/core` session registry types with optional tmux metadata.
2. Teach file-session-registry validation and persistence about those fields.
3. Implement `createTmuxBackend()` plus tests.
4. Export the backend from `@koi/daemon`.
5. Update daemon registration/spawn wiring to persist tmux metadata.
6. Upgrade `koi bg attach` / `detach` to use tmux metadata.
7. Add gated tmux integration coverage.

## Open decisions resolved

- Persist tmux target metadata in the registry: yes.
- Put attach semantics in the CLI instead of the backend: yes, because attach is cross-process operator behavior.
- Reuse the existing registry `detached` state: yes.
- Build a full layout manager: no, not required for this issue.
