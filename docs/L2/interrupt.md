# Interrupt & Cancellation Protocol

**Issue:** #1653 · **Follow-ups:** #1682 (programmatic API), #1683 (durable resume)

## Goal

Users can interrupt a running agent at any time (Ctrl+C in a shell, Ctrl+C in the TUI, programmatic abort) without losing state or corrupting accounting. The agent finishes its current atomic operation (or aborts it if the tool cooperates), emits a terminal `done` event with `stopReason: "interrupted"`, and halts cleanly.

Double-Ctrl+C within 2 seconds forces an immediate exit with code 130 (standard SIGINT convention) as an escape hatch when graceful cleanup hangs.

## Design principles

1. **No new cancellation vocabulary.** Koi already threads `AbortSignal` through `EngineInput`, `ModelRequest`, `ToolRequest`, and `TurnContext`. Cancellation reuses that plumbing — no custom token class, no middleware-owned controllers, no second interposition layer.
2. **Hosts own the controller.** The live `AbortController` for a run belongs to the CLI/TUI host (`commands/start.ts`, `tui-command.ts`), not to L0, L1, or a new L2 package. L1 and L2 are pure observers of `ctx.signal`.
3. **`done.stopReason === "interrupted"` is the terminal event.** No new `agent.cancelled` event kind. The engine, query runner, and TUI flush path already treat `done` as terminal — adding a second terminal event would fork the control plane.
4. **Partial accounting is preserved.** A cancel mid-stream still emits a single final `done` with the partial `usage` collected so far. Callers never see a cancel path that silently loses tokens.
5. **Cancel is idempotent.** Multiple `abort()` calls — or a Ctrl+C arriving during cleanup — produce exactly one terminal `done`.

## The protocol

### Layered view

```
┌──────────── Host (CLI/TUI) ────────────┐
│   AbortController + SIGINT state machine│
│           │                              │
│           ▼ signal                       │
├──────────── L1 @koi/engine ─────────────┤
│   run(input, { signal })                 │
│   ├─ modelStream (wraps iterator.next    │
│   │   vs. signal)                        │
│   └─ createToolExecutionGuard            │
│       (composes signal + per-call timeout)│
│           │                              │
│           ▼ signal                       │
├──────────── L2 tools / adapters ────────┤
│   tool.execute({ signal }): honor it     │
│   model adapter: forward to fetch()      │
└──────────────────────────────────────────┘
```

### Terminal semantics

When `signal.aborted === true` at any of the checkpoints below, the run terminates with:

```ts
{ kind: "done",
  output: {
    stopReason: "interrupted",
    usage: { /* partial token counts collected so far */ },
    ...
  } }
```

**Checkpoints:**
- Before a turn starts (early exit — no model call)
- Mid-model-stream (abort propagated to the underlying `fetch()` via the streaming adapter)
- Between chunks (stream consumer races `iterator.next()` against `signal`)
- Before a tool call (tool execution guard short-circuits)
- Mid-tool-call (cooperative tools honor `ToolExecuteOptions.signal`; non-cooperative tools run to completion, then the terminal `done` fires)

### SIGINT state machine (host-owned)

Both CLI hosts use the same two-tap state machine:

```
idle ──SIGINT──▶ graceful
   ▲               │
   │               ├── SIGINT within 2000ms ──▶ process.exit(130)
   │               │
   │               └── controller.abort() → run ends with
   │                    stopReason:"interrupted" ──▶ idle (natural exit)
   │
   └── failsafe(8000ms, .unref()) ──▶ process.exit(130)
```

- **First SIGINT:** call the host's graceful action (abort the active stream in the TUI; abort the session-wide `AbortController` in `koi start`), print `Interrupting… (Ctrl+C again to force)` to stderr, arm a 2000ms double-tap window.
- **Second SIGINT within 2000ms:** force-exit path (`process.exit(130)` in `koi start`, full shutdown with runtime teardown in the TUI).
- **Window elapse behavior depends on host policy** (`onWindowElapse`):
  - `stay-armed` (TUI default): once the first tap has armed the state machine, ANY subsequent SIGINT forces — the window just rate-limits how fast a double-tap qualifies. The handler returns to idle only when the host calls `complete()` (wired to the drain loop's `finally` so the next turn starts fresh) or when force is triggered.
  - `reset-to-idle`: when the 2000ms window elapses without a second tap, the handler returns to idle and the next SIGINT is a new first tap. Used when the host has no `complete()` hook.
- **`koi start` uses `failsafeMs: 30_000`** — if a non-cooperative tool never honors the abort, the handler auto-escalates to the force path after 30s rather than leaving the session hung indefinitely.
- **The TUI uses no `failsafeMs`** — interrupted turns aren't committed to the transcript, so silent auto-escalation would lose session context. Users who want an unconditional force-exit double-tap explicitly.

The state machine is installed in `packages/meta/cli/src/commands/start.ts` and `packages/meta/cli/src/tui-command.ts`. It is **not** installed in `packages/meta/cli/src/bin.ts` — the TUI re-execs into a child process, and the state machine must live with the process that owns the `AbortController`.

### Programmatic API

**Purpose:** External callers (HTTP handlers, test harnesses, parent agents) can interrupt a running agent without owning the `AbortController` themselves. This decouples the interrupt authority from the object lifecycle — the registry acts as a shared interrupt table.

**`SessionRegistry` interface and factory:**

```ts
export interface SessionRegistry {
  /**
   * Register a live run. The caller passes the run's branded `runId`, the
   * per-run `AbortController`, and the composite `runSignal` the engine
   * observes (`AbortSignal.any([input.signal, controller.signal])`).
   * Returns an unregister function that is safe to call multiple times.
   * Throws `CONFLICT` if the sessionId is already registered (shared-
   * registry cross-runtime collision — see Caveats).
   */
  readonly register: (
    sessionId: SessionId,
    runId: RunId,
    controller: AbortController,
    runSignal: AbortSignal,
  ) => () => void;

  /**
   * Abort the run registered for sessionId. When `expectedRunId` is
   * supplied, the registry requires the active entry's runId to match
   * before aborting — this is the safe cross-generation cancellation path.
   * Returns true only on the first abort for the matching active entry.
   * Returns false for unknown session, aborted-already, or runId mismatch.
   */
  readonly interrupt: (
    sessionId: SessionId,
    reason?: string,
    expectedRunId?: RunId,
  ) => boolean;

  /** True iff the active entry's composite run signal is aborted. */
  readonly isInterrupted: (sessionId: SessionId) => boolean;

  /** Snapshot of currently registered sessionIds. Does NOT expose runIds —
   *  exposing them would let any caller holding the registry cancel or
   *  evict another runtime's run. Callers cancel only their own runs,
   *  whose runIds they already have via `runtime.currentRunId` or
   *  `RunHandle.runId`. */
  readonly listActive: () => readonly SessionId[];

  /**
   * Administrative recovery: evict a registry entry by sessionId, proving
   * ownership via the matching `expectedRunId`. Does NOT abort the owning
   * runtime — only removes the registry entry. Use when a runtime has
   * wedged or crashed and you need to free the sessionId for a replacement.
   */
  readonly forceUnregister: (sessionId: SessionId, expectedRunId: RunId) => boolean;
}

export function createSessionRegistry(): SessionRegistry;
```

The registry holds `AbortController` and composite-signal references only — no transcript, no engine state. It is an in-memory table of active runs.

**Integration with `createKoi()` and `run()`:**

Pass the registry at factory time:

```ts
const registry = createSessionRegistry();
const runtime = await createKoi({
  manifest,
  adapter,
  sessionRegistry: registry,
});
```

The engine wires the registry into the existing `run()` lifecycle:

- **On `run()` entry:** After the per-run `AbortController` is created and before any await, the engine calls `registry.register(runtime.sessionId, controller)`. It captures the sessionId at registration time (not later), so `cycleSession()` rotating the sessionId during a run does not orphan the registration.
- **On `run()` exit:** In the `finally` block (normal completion, error, or abort), the engine calls the unregister function returned by `register()`. Unregister is idempotent and safe to call from any path.

**`runtime.run()` returns a `RunHandle`:**

Each `runtime.run(input)` call returns a `RunHandle` — an `AsyncIterable<EngineEvent>` carrying `runId` and a run-scoped `.interrupt()`. Use the handle's `.interrupt()` (not `runtime.interrupt()`) whenever you store the cancel callback for later delivery, since it is bound to the specific run and cannot accidentally hit a later run on the same runtime.

```ts
export interface RunHandle extends AsyncIterable<EngineEvent> {
  readonly runId: RunId;
  /** Abort this specific run. Safe across run generations — becomes a
   *  no-op after this run completes, never hits a later run. */
  readonly interrupt: (reason?: string) => boolean;
}
```

**`KoiRuntime.interrupt` / `.isInterrupted` / `.currentRunId`:**

For callers that already hold the runtime reference and want to act on "whatever run is currently active on this specific runtime":

```ts
export interface KoiRuntime {
  /** Session-scoped cancel targeting THIS runtime's active run. Returns
   *  false if this runtime is idle (fails closed — will not reach across
   *  to a sibling runtime that shares a SessionRegistry + sessionId). */
  readonly interrupt: (reason?: string) => boolean;

  /** True iff THIS runtime's active composite signal is aborted. */
  readonly isInterrupted: () => boolean;

  /** RunId of the active run on THIS runtime, or `undefined` between runs. */
  readonly currentRunId: RunId | undefined;
}
```

**Return-value contract for `interrupt()`:**

`registry.interrupt(sessionId, reason?, expectedRunId?)` returns `true` **only on the first abort** for a matching active entry. It returns `false` if:
- The session is unknown (never registered or already unregistered)
- The session is known but its composite signal is already aborted (idempotent — no change occurred)
- `expectedRunId` is supplied and does not match the active entry's `runId` (cross-generation stale cancel)

This contract makes multiple calls to `interrupt()` safe and distinguishable, and run-scoped when the caller supplies `expectedRunId`.

**Cross-generation safety (delayed cancels, retries, watchdogs):**

`registry.interrupt(sessionId, reason)` without `expectedRunId` is **session-scoped** — it will hit *whichever* run is active on that sessionId right now. That is dangerous for any caller that stores a cancel callback and may fire it across run generations (HTTP retries, watchdogs, parent-agent timeouts). If run A finishes and run B starts on the same runtime, a late cancel intended for A would kill B.

The safe pattern for delayed cancellation:

- **Preferred — use `RunHandle.interrupt()`**: the handle captures its own `runId` and its `.interrupt()` is a no-op for any run other than the one it came from.
- **Equivalent — capture `runtime.currentRunId` at run start, pass as `expectedRunId`** to `registry.interrupt()`:

  ```ts
  const handle = runtime.run(input);
  const myRunId = handle.runId; // or runtime.currentRunId
  // ...later, possibly after A has finished...
  registry.interrupt(sessionId(runtime.sessionId), "watchdog", myRunId);
  // → no-op if a different run is now active
  ```

**Registry entry lifecycle:**

```
not-registered
       │
       ├─ run() starts ──▶ register(sessionId, controller)
       │
       ▼
active-and-running
       │
       ├─ registry.interrupt() ──▶ controller.abort()
       │                   │
       │                   ▼
       │              run() detects abort ──▶ emits done with stopReason:"interrupted"
       │
       ├─ run() ends (normal, error, or abort) ──▶ finally calls unregister()
       │
       ▼
not-registered (entry drained)
```

**Example — safe cross-generation flow:**

```ts
import { createKoi, createSessionRegistry, sessionId } from "@koi/engine";

const registry = createSessionRegistry();
const runtime = await createKoi({ manifest, adapter, sessionRegistry: registry });

// Start a run and capture its handle (carries runId and run-scoped interrupt).
const handle = runtime.run({ messages: [...] });

// Store a watchdog cancel callback. Using handle.interrupt binds the cancel
// to THIS run — a later run on the same runtime cannot be hit by mistake.
const watchdog = setTimeout(() => handle.interrupt("watchdog"), 30_000);

// Iterate as usual.
for await (const ev of handle) {
  if (ev.kind === "done") clearTimeout(watchdog);
}

// OR: external cancel via the registry with run-scoped safety.
const activeRunId = runtime.currentRunId; // captured while the run is active
registry.interrupt(
  sessionId(runtime.sessionId),
  "external-cancel",
  activeRunId, // expectedRunId guards against hitting a later run
);
```

**Caveats:**

- **`RunHandle` is single-consumer.** Calling `[Symbol.asyncIterator]()` twice on one handle throws — start a new `run()` to get a fresh iterable. `for await` is fine; it calls the method once.
- **Cross-runtime shared registry.** A `SessionRegistry` shared by multiple `KoiRuntime` instances tracks per-`(sessionId, runId)` entries. Duplicate `register()` on the same sessionId from a *different* runtime throws `CONFLICT` (retryable). Hosts running resume/rebind flows that may collide on sessionIds should use per-runtime registries, or coordinate sessionId uniqueness upstream.
- **Idle runtime safety.** `runtime.interrupt()` and `runtime.isInterrupted()` fail closed when the specific runtime instance is idle — they never reach across a shared registry into a sibling runtime's entry, even when sessionIds match.
- **Stuck-runtime recovery.** A wedged runtime whose `finally` cleanup never fires can be evicted from the registry with `registry.forceUnregister(sessionId, runId)`. This does NOT abort the owning runtime — dispose it separately. Only the owning runtime can force-unregister (it holds its own `runId`); outside callers who don't own a run cannot enumerate runIds to bypass the ownership check.
- **Registry is in-process.** No cross-process coordination. If your architecture spawns separate processes or threads, each process needs its own registry instance.
- **`cycleSession()` rotates the sessionId.** Captured sessionIds/runIds from before a rotation become stale; subsequent `registry.interrupt()` calls on them are no-ops. Read `runtime.sessionId` / `runtime.currentRunId` live, or prefer `RunHandle.interrupt()` which captures both transparently.

### TUI key bindings

- **Ctrl+C** → calls `onInterrupt()` → calls `controller.abort()`. First tap = graceful, second tap within 2s = force.
- **Esc** → unchanged. Dismisses modals / navigates back. Esc is **not** an interrupt; remapping it would be a UX decision outside this protocol.

## Tool author guide

If you are writing a tool, honor the `signal` you receive in `ToolExecuteOptions`:

```ts
async execute(args, { signal }) {
  signal.throwIfAborted();                        // pre-check
  const result = await doWork({ signal });        // forward to any async I/O
  signal.throwIfAborted();                        // post-check
  return result;
}
```

Tools fall into three practical buckets:

| Bucket | Example | Cancel behavior |
|---|---|---|
| **Pre-start abortable** | any tool | Check `signal.aborted` before dispatch. Cheap and always correct. |
| **Mid-flight cooperative** | `browser_wait`, long-poll, streaming fetch | Wire `signal` into the underlying async primitive so it aborts mid-flight. |
| **Post-commit non-revertible** | MCP remote call, filesystem write | Cannot be cancelled mid-flight. Let the current atomic op finish, then the terminal `done` fires. Do not attempt to roll back on abort. |

Per-tool `interruptBehavior` metadata in the manifest is explicitly **not** introduced in this protocol. The behavior is a property of the tool's implementation, not its declaration, and the current tool surface is too heterogeneous to express as a single flag.

## Known limitations

- **PID-directed `kill -INT <wrapperPid>` does not reach the TUI child.** The `koi tui` launcher re-execs into a browser-build child process. Forwarding SIGINT would double-deliver every terminal Ctrl+C (since the terminal delivers to the whole foreground process group) and depend on a time-based coalesce heuristic. Spawning the child in a separate process group (`detached: true`) would solve the delivery ambiguity but is unsafe for interactive children: a background-pgroup process reading from the controlling tty gets SIGTTIN under job control and freezes, and Bun/Node do not expose `tcsetpgrp` to transfer terminal foreground ownership. Supervisors should use **SIGTERM** for PID-directed termination — the wrapper forwards SIGTERM and escalates to SIGKILL after 10s if the child wedges. Terminal Ctrl+C works normally via process-group delivery.
- **MCP tools cannot be cancelled mid-flight.** The MCP protocol has no cancel verb. `packages/net/mcp/src/tool-adapter.ts` checks `signal.aborted` before dispatch but cannot interrupt an in-flight remote call. The terminal `done` fires once the MCP call settles.
- **Durable resume is not supported yet.** Cancelling a session halts it cleanly but does not persist `EngineState`. See #1683 for the resume-from-checkpoint story. Transcript-based resume via `koi resume <sessionId>` (existing `SessionPersistence`) still works for stateless adapters.
- **Team runtime fan-out cancel is a separate issue.** Spawned sub-agents that detach from the parent signal (deferred / on-demand delivery modes) will continue running after the parent is cancelled.

## Testing

The protocol is verified by tests in:

- `packages/meta/cli/src/commands/start.test.ts` — double-SIGINT force path, failsafe timer
- `packages/meta/cli/src/tui-command.test.ts` — same for the TUI host
- `packages/kernel/engine/src/__tests__/compose-bridge.test.ts` + `packages/lib/query-engine/src/__tests__/consume-stream.test.ts` — mid-stream cancel yields exactly one `done` with `stopReason: "interrupted"` and preserved partial usage
- `packages/ui/tui/src/worker/__tests__/engine-channel.test.ts` — same-burst `text_delta` ordering preserved through the flush path under cancel
- `packages/lib/tool-browser/src/tools/wait.test.ts` — cooperative tool aborts mid-wait
- `packages/net/mcp/src/__tests__/tool-adapter.test.ts` — pre-aborted signal never dispatches

## References

- `packages/kernel/core/src/engine.ts` — `AbortSignal` in `EngineInput`, `AbortReason` union
- `packages/kernel/core/src/middleware.ts` — `signal` on `TurnContext`, `ModelRequest`, `ToolRequest`
- `packages/kernel/engine-compose/src/tool-execution-guard.ts` — existing signal + timeout composition
- `packages/kernel/engine/src/compose-bridge.ts` — streaming cancel path
- `packages/lib/query-engine/src/consume-stream.ts` — stream iterator vs. signal race
