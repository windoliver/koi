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
- **No programmatic `interrupt(sessionId)` API yet.** Today you need to own the `AbortController` to cancel a run. See #1682 for the runtime session registry.
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
