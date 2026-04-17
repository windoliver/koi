# @koi/middleware-task-anchor

System-reminder injection middleware that re-anchors model attention on the
live task board after `K` idle turns with no task tool activity (Layer 2).

## Why

Tasks created early in a session get forgotten as the transcript grows. Claude
Code's observed pattern is a `<system-reminder>` block that refreshes the model
on the current task list whenever it has stopped using task tools for a while.
This package mirrors that behavior: the model sees its own live plan again,
without the user having to retype it.

Complements the model-driven task pattern (#1848):

- Issue #1836 `middleware-planning` — `write_plan` tool for structured plans
- Issue #1837 `middleware-task-anchor` — this package, stale-board refresher
- Issue #1842 `middleware-plan-persist` — file-backed plan persistence

## Architecture

Observe-phase middleware (priority 340) with four hooks.

```
Session start → init session state (idle=0)
Tool call     → if task tool, reset idle counter to 0
Before turn   → increment idle counter
Model call    → if idle >= K, prepend <system-reminder> with live board
Session end   → drop session state
```

**Idle counter:** Increments on every `onBeforeTurn`. Any `wrapToolCall` whose
`toolId` matches `isTaskTool(toolId)` resets it to 0 (default match:
`toolId.startsWith("task_")`). When `idle >= idleTurnThreshold`, the next
`wrapModelCall`/`wrapModelStream` prepends a `system:task-anchor` message and
resets the counter to 0.

**Empty-board nudge:** When the board is empty but at least one tool call has
happened in the session (signal: "complex work in progress"), the reminder
instead nudges the model to use `task_create`. Disable with
`nudgeOnEmptyBoard: false`.

**Message format:** Injected as an `InboundMessage` with
`senderId: "system:task-anchor"`. The shared `filterResumedMessagesForDisplay`
contract drops any `system:*` sender from user-facing transcripts, so the
reminder is never shown to the user.

**Board accessor:** The middleware does not own the board. Callers supply a
`getBoard(sessionId)` accessor that returns a `TaskBoard` snapshot (sync or
async). Typical wiring: the runtime creates a `ManagedTaskBoard` per session
and hands its `snapshot()` through this accessor.

## API

```typescript
import { createTaskAnchorMiddleware } from "@koi/middleware-task-anchor";

const taskAnchor = createTaskAnchorMiddleware({
  getBoard: (sessionId) => boards.get(sessionId)?.snapshot(),
  idleTurnThreshold: 3,
});

// Use `taskAnchor` in the middleware stack.
```

### TaskAnchorConfig

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `getBoard` | `(sid) => TaskBoard \| undefined \| Promise<…>` | — | Live board accessor |
| `idleTurnThreshold` | `number` | `3` | K — idle turns before re-anchor fires |
| `isTaskTool` | `(toolId) => boolean` | starts with `"task_"` | Any task-related tool (reads + writes). Resets the idle counter |
| `isMutatingTaskTool` | `(toolId) => boolean` | `task_{create,update,delegate,stop}` | Mutating subset. Drives stop-gate rollback that suppresses the empty-board nudge on retries after successful board mutation |
| `nudgeOnEmptyBoard` | `boolean` | `true` | Suggest `task_create` when board is empty + tool activity seen |
| `header` | `string` | `"Current tasks"` | Header text inside the reminder |

**Hardening note for `isMutatingTaskTool`:** the default list is a manually
maintained snapshot of `@koi/task-tools` — a layer boundary forbids importing
upstream descriptors directly. If you register a custom task-tool surface, pass
`isMutatingTaskTool: (id) => myMutatingSet.has(id)` explicitly so the rollback
path recognizes your mutating tools and doesn't suppress the empty-board nudge
spuriously.

### Injected message shape

```xml
<system-reminder>
Current tasks:
- [x] Audit auth code
- [in_progress] Design new session model
- [ ] Migrate sessions
Don't mention this reminder to the user.
</system-reminder>
```

Empty-board nudge:

```xml
<system-reminder>
No tasks on the board. If this conversation involves multiple steps,
call task_create to decompose the work before continuing.
Don't mention this reminder to the user.
</system-reminder>
```

## Error Handling

| Scenario | Behavior |
|----------|----------|
| `getBoard` throws or rejects | Reminder skipped this turn, idle counter untouched, error swallowed |
| `isTaskTool` throws | Treated as non-match — idle counter unchanged |
| No session state at model-call time | Pass through unchanged (session missed `onSessionStart`) |
| Board present but no tasks, `nudgeOnEmptyBoard: false` | Pass through, counter unchanged |

## Layer Compliance

- Depends on: `@koi/core` (L0), `@koi/errors` (L0u)
- No dependency on `@koi/task-board` — consumes only the L0 `TaskBoard`
  interface, so any board implementation (immutable, managed, test double)
  satisfies the accessor
- No L1 or peer L2 imports
- All interface properties `readonly`
- `bun run check:layers` passes

## References

- Issue #1837 (this package)
- Issue #1848 (v2 Phase 3 — model-driven task pattern)
- CC source: `src/utils/attachments.ts` lines 3375–3432,
  `src/utils/messages.ts` lines 3680–3698
- v1 predecessor: `archive/v1/packages/middleware/middleware-goal/src/reminder/`
