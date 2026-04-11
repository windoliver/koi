# Graceful Interrupt + Cancellation Protocol — Issue #1653 (v2, post-review)

**Branch:** `feat/interrupt-cancellation-1653`
**Worktree:** `/Users/sophiawj/private/koi-interrupt-1653`
**Status:** revised after `codex:adversarial-review` of the v1 plan.

## 0. What changed after review

The v1 plan proposed a new `@koi/interrupt` L2 package with cancel middleware, a new `agent.cancelled` event, a `CheckpointAdapter` abstraction, a per-tool `interruptBehavior` field, and a SIGINT handler wired in `cli/bin.ts`. The review found this is the wrong shape:

- **Middleware hooks can't emit terminal events or set `stopReason`.** Only L1 owns the control plane. `onBeforeTurn`/`onAfterTurn` return `Promise<void>`.
- **No session registry to hang `interrupt(sessionId)` off of.** The only live cancel handles today are host-owned `AbortController`s in `commands/start.ts` and `tui-command.ts`.
- **`agent.cancelled` duplicates existing `done.stopReason === "interrupted"`.** The engine, query runner, and TUI flush path are already built around `done` as the terminal event.
- **Source fields like `tui_ctrl_c` leak host vocab into L0** — forbidden by CLAUDE.md.
- **A second interposition layer for cancel** would double-instrument tool and model calls alongside `createToolExecutionGuard`.
- **`CheckpointAdapter` is a second persistence vocabulary.** The repo already has `EngineAdapter.saveState/loadState`, `SessionRecord.lastEngineState`, `SessionPersistence`.
- **`process.once('SIGINT')` is already installed** in `commands/start.ts:412` and `tui-command.ts:596`. There's no double-tap today because of `once`, not because handlers are missing. `cli/bin.ts` is not the live session owner (TUI re-execs into a child).
- **`interruptBehavior: 'cancel'|'block'`** is too coarse: tools fall into three buckets (pre-start abortable, mid-flight cooperative, post-commit non-revertible), and MCP can't cancel in-flight remote calls.
- **No-op checkpoint adapter is not mergeable if resume is in scope.** An in-memory stub contradicts "interrupt without losing state."

## 1. Revised scope

**Land as this PR (graceful interrupt):**
1. Replace `process.once('SIGINT')` with double-tap state machines in `commands/start.ts` and `tui-command.ts`. First SIGINT = graceful (calls existing `AbortController.abort()`); second within 2s = `process.exit(130)`; failsafe `.unref()` timer as defense-in-depth.
2. Audit and fix signal propagation in concrete tools where it's wrong or missing. Concrete targets identified by review: `packages/lib/tool-browser/src/tools/wait.ts:62` (ignores `ToolExecuteOptions`), MCP adapter at `packages/net/mcp/src/tool-adapter.ts:76`, filesystem tools in `packages/lib/tools-builtin/src/tools/`.
3. Verify `done.output.stopReason === "interrupted"` flows end-to-end through streaming cancel path in `packages/kernel/engine/src/compose-bridge.ts:200` and `packages/lib/query-engine/src/consume-stream.ts:63`, and that it arrives at the TUI after the existing `flushSync()` in `engine-channel.ts:135`.
4. Tests: double-SIGINT force path, mid-model cancel preserves partial usage in final `done`, mid-tool cancel for cooperative tools, TUI final-flush ordering under cancel.
5. Doc: `docs/L2/interrupt.md` documents the existing protocol (AbortSignal + `stopReason: "interrupted"` + SIGINT state machine) — not a new package.

**Explicitly out of this PR (split to follow-ups):**
- **Durable resume-from-cancel** (AC #6). Blocks on `EngineState` being reliably persisted through `SessionPersistence` for adapters that support it. Separate issue to wire `saveState/loadState` into the cancel path.
- **Programmatic `agent.interrupt(sessionId)` API** (AC #1). Requires a session registry in `@koi/engine` — L1 change, separate issue. Today, programmatic cancel works if you own the `AbortController`.
- **Team runtime fan-out cancel** — already a separate issue per the ticket.
- **New L0 `agent.cancelled` event** — rejected. Reuse `done.stopReason === "interrupted"`.
- **Per-tool `interruptBehavior` manifest field** — rejected until concrete tool audit is complete.
- **`@koi/interrupt` L2 package** — not created. No L2 code lives in `packages/lib/interrupt/`.

This is a tighter PR that matches what the issue actually promises *and* what the repo can support today. The two AC items we drop (resume, programmatic API) become explicit follow-up issues linked in the PR description.

## 2. Concrete work items

| # | File | Change |
|---|---|---|
| 2.1 | `packages/meta/cli/src/commands/start.ts:412` | Replace `process.once('SIGINT', ...)` with double-tap state machine. First tap → existing `abort()` + print "Interrupting… (Ctrl+C again to force)". Second tap within 2000ms → `process.exit(130)`. Failsafe `setTimeout(exit(130), 8000).unref()`. |
| 2.2 | `packages/meta/cli/src/tui-command.ts:596` | Same pattern at the TUI child-process level. Coordinate with existing `onInterrupt()` at `tui-command.ts:359-362`. Do NOT remap Esc. |
| 2.3 | `packages/ui/tui/src/keyboard.ts:60` | Leave as-is. Ctrl+C → existing `onInterrupt()`. No behavior change. |
| 2.4 | `packages/lib/tool-browser/src/tools/wait.ts:62` | Honor `ToolExecuteOptions.signal`. Add `signal.addEventListener('abort', ...)` to short-circuit the wait. |
| 2.5 | `packages/net/mcp/src/tool-adapter.ts:76` | Document that in-flight MCP calls can't be aborted mid-flight. Check `signal.aborted` before dispatch to at least abort pre-start. |
| 2.6 | `packages/lib/tools-builtin/src/tools/{read,write,edit}.ts` | Add `throwIfAborted()` before and after backend calls. Already partially done per review. |
| 2.7 | `packages/kernel/engine/src/compose-bridge.ts:200` + `packages/lib/query-engine/src/consume-stream.ts:63` | Verify with a test that cancel mid-stream produces exactly one final `done` event with `stopReason: "interrupted"` and partial `usage` preserved. |
| 2.8 | `packages/ui/tui/src/batcher/event-batcher.ts:35` + `packages/ui/tui/src/worker/engine-channel.ts:135` | Verify `flushSync()` runs before terminal interrupted state — add test for same-burst `text_delta` → cancel ordering. |
| 2.9 | `docs/L2/interrupt.md` | New doc: cancellation protocol in Koi (AbortSignal everywhere, `stopReason: "interrupted"` as terminal, SIGINT state machine at hosts, known limitations: MCP mid-flight, no durable resume yet). |
| 2.10 | `docs/L2/interrupt.md` + PR body | Link follow-up issues: (a) durable resume via `EngineState`, (b) programmatic `interrupt(sessionId)` via runtime session registry, (c) per-tool interrupt behavior audit. |

## 3. Test plan

Doc → Tests → Code, per CLAUDE.md.

| Test | Target | Covers |
|---|---|---|
| `commands/start.test.ts` — double-SIGINT force | 2.1 | AC #2 |
| `commands/start.test.ts` — single-SIGINT + failsafe timer fires if abort hangs | 2.1 | AC #2, defense-in-depth |
| `tui-command.test.ts` — double-SIGINT force in TUI child | 2.2 | AC #2 |
| `tool-browser/wait.test.ts` — abort mid-wait returns early | 2.4 | AC #4 |
| `mcp/tool-adapter.test.ts` — pre-aborted signal never dispatches | 2.5 | AC #4 |
| `compose-bridge.test.ts` / `consume-stream.test.ts` — mid-stream cancel yields exactly one `done` with `stopReason:"interrupted"` and non-zero `usage.input_tokens` | 2.7 | AC #3, accounting |
| `engine-channel.test.ts` — same-burst text_delta + cancel preserves all deltas before terminal state | 2.8 | AC #5 (final-flush guarantee) |
| `engine-channel.test.ts` — idempotent double-abort is a no-op (single terminal `done`) | 2.1–2.7 | idempotency |

Per CLAUDE.md L2 rule: since we're not adding a new L2 package, no new golden query recording is required. We should still verify existing golden trajectories don't regress.

## 4. Answers to v1 plan's open questions (grounded in review)

1. **Hierarchical `AbortController` tree** → not introduced as a new primitive. Use existing `AbortSignal` composition (`AbortSignal.any()`). The repo standardizes on `AbortSignal` everywhere — don't invent a wrapper.
2. **2s double-tap window** → accepted. Lives in host files, not kernel.
3. **Tool `interruptBehavior` manifest field** → rejected for now. Audit concrete tools first.
4. **`agent.cancelled` event kind** → rejected. Reuse `done.stopReason === "interrupted"`.
5. **Cancel ownership** → host owns the `AbortController`. No middleware session map. Middleware is pure observer of `ctx.signal`.
6. **Failsafe timer location** → CLI/TUI host files, not kernel, not a new L2. Matches where `process.exit()` lives today.
7. **No-op checkpoint adapter** → rejected. Durable resume is split into a follow-up issue that uses `SessionPersistence` + `EngineState`.

## 5. Implementation order

1. `docs/L2/interrupt.md` — document the existing + revised protocol (Doc gate).
2. Failing tests for 2.1, 2.2, 2.4, 2.5, 2.6, 2.7, 2.8.
3. Code: 2.1 + 2.2 (SIGINT state machine in both host files).
4. Code: 2.4, 2.5, 2.6 (tool signal propagation fixes).
5. Verify 2.7 + 2.8 — likely already works, tests pin the behavior.
6. CI green: `test`, `typecheck`, `lint`, `check:layers`, `check:orphans`, `check:golden-queries`.
7. Open PR from worktree. Body explicitly calls out which ACs this PR covers (#2, #3, #4, #5, #7) and which ship as follow-ups (#1 programmatic API, #6 durable resume).

## 6. Risk & open items

- **Risk: TUI re-exec complicates SIGINT.** The TUI child process receives SIGINT independently of the parent `cli/bin.ts`. Need to confirm via a manual test that double-tap in the *TUI child* exits the child cleanly and the parent then exits with 130.
- **Risk: `compose-bridge` + `consume-stream` may already handle cancel correctly.** If so, 2.7 is just "pin the behavior with a test" — good outcome. If they don't, that's the actual bug to fix.
- **Open: should we land the follow-up issues for resume + programmatic API as stubs now (linked), or wait for this PR to merge first?** Recommend: file them *before* opening this PR so the PR body can link them.

## 7. Definition of done

- [ ] `docs/L2/interrupt.md` exists and describes the cancellation protocol.
- [ ] Double-SIGINT works in both `koi start` and TUI.
- [ ] Cancel mid-model yields exactly one `done` with `stopReason: "interrupted"` and preserved partial `usage`.
- [ ] Cancel mid-tool aborts cooperative tools (`browser_wait`, filesystem, MCP pre-dispatch).
- [ ] TUI final-flush ordering verified under cancel.
- [ ] Two follow-up issues filed and linked in the PR body: resume, programmatic API.
- [ ] CI green: `test / typecheck / lint / check:layers / check:orphans / check:golden-queries`.
