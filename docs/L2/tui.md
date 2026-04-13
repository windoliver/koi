# @koi/tui — State Layer + UI Components

> TUI rendering state, reducer, command palette, status bar, and session picker.

**Layer:** UI (depends on `@koi/core` only)
**Location:** `packages/ui/tui/src/`
**Issues:** #1265 (Phase 2j-1), #1268 (Phase 2j-4)

## Purpose

Manages all state needed to render the TUI: conversation messages, active view,
modal overlays, connection status, layout, and zoom level. This is a
**rendering concern only** — not a data store, not an admin panel, not a
persistence layer.

## Architecture

```
EngineEvent (from @koi/core)
    │
    ▼
┌──────────────────────┐
│  reduce(state, action)│  ← pure function, no side effects
│  - delta accumulation │
│  - message compaction │
│  - view transitions   │
└──────────┬───────────┘
           │
           ▼
┌──────────────────────┐
│  TuiStore            │  ← SolidJS store + reconcile()
│  - getState()        │     returns reactive proxy
│  - dispatch(action)  │     reducer + reconcile() deep-diff
│  - dispatchBatch()   │     reduces N actions, single reconcile
│  - subscribe(fn)     │     external listener (non-Solid consumers)
└──────────────────────┘
           │
           ▼
┌──────────────────────┐
│  useTuiStore(sel)     │  ← direct getter (no createMemo)
│                       │     SolidJS tracks reads at call site
│                       │     works for scalars AND objects/arrays
└──────────────────────┘
```

### Streaming Features

- **Thinking indicator**: animated `⠹ Thinking…` spinner while waiting for first token
- **Progressive streaming**: frame-rate-limited flush+yield (16ms) for all streaming events
- **Code block isolation**: splits at unclosed fence, memoizes stable head
- **Markdown healing**: code-aware closer for unclosed formatting (width-aware fences)
- **Accordion collapse**: tool results collapsed by default (Ctrl+E toggle-all)
- **Copy-on-select**: mouse-drag selection auto-copies to clipboard via OSC 52; Ctrl+C fallback
- **Auto-scroll**: scroll-up pauses, selection preserves scroll, settle on stream end
- **Prompt history**: arrow up/down (session-scoped, clears on reset)
- **Diff display**: unified diffs for `_edit` tools (supports `edits[]` schema)
- **Elapsed timer**: `streaming… 5s` in status bar during processing

## State Shape

```typescript
interface TuiState {
  readonly messages: readonly TuiMessage[];
  readonly activeView: TuiView;
  readonly modal: TuiModal | null;
  readonly connectionStatus: ConnectionStatus;
  readonly layoutTier: LayoutTier;
  readonly zoomLevel: number;
  // Plan/progress tracking (#1555)
  readonly planTasks: readonly PlanTask[] | null;  // latest board snapshot, null until first plan_update
  // Status bar data (Phase 2j-4)
  readonly sessionInfo: SessionInfo | null;       // set by host on session start
  readonly cumulativeMetrics: CumulativeMetrics;  // accumulated across all turns
  readonly agentStatus: AgentStatus;              // idle | processing | error
  // Session picker data (Phase 2j-4)
  readonly sessions: readonly SessionSummary[];   // sorted most-recent-first, max 50
  // Streaming & tool display (#1581)
  readonly runningToolCount: number;              // O(1) check for spinner activation
  readonly toolsExpanded: boolean;                // Ctrl+E toggle for accordion collapse
  // Trajectory view data — injected by host via set_trajectory_data
  readonly trajectorySteps: readonly TrajectoryStepSummary[];
}
```

Fourteen flat fields. `runningToolCount` replaced the O(messages*blocks) `hasRunningTools` scan.
`toolsExpanded` is the global toggle for tool result accordion collapse (Ctrl+E).

`PlanTask` is a rendering-only type with `id`, `description`, and `status` — the TUI
never imports `TaskItem` from `@koi/core`.

`TrajectoryStepSummary` is a rendering-only summary of one ATIF trajectory step. Each
summary carries `stepIndex`, `kind`, `identifier`, `durationMs`, `outcome`, `timestamp`,
`requestText`, `responseText`, `errorText`, `tokens` (`TrajectoryTokenMetrics`), and
`middlewareSpan` (`TrajectoryMiddlewareSpan`). `TrajectoryMiddlewareSpan` contains
`hook` (e.g., `"wrapModelCall"`), `phase`, and `nextCalled`. These types are injected
by the host — the TUI never reads from the trajectory store directly.

## Message Model

Messages are **materialized** — the reducer accumulates streaming deltas into
render-ready objects. Views never reconstruct display state from raw events.

```typescript
type TuiMessage =
  | { kind: "user"; id: string; blocks: readonly ContentBlock[] }
  | { kind: "assistant"; id: string; blocks: readonly TuiAssistantBlock[]; streaming: boolean }
  | { kind: "system"; id: string; text: string }

type TuiAssistantBlock =
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "tool_call"; callId: string; toolName: string;
      status: "running" | "complete" | "error";
      args?: string;    // streamed argument JSON fragments
      result?: string }  // tool execution result (stringified by capResult())
  | { kind: "error"; code: string; message: string }
```

**IDs are deterministic:** `assistant-${turnIndex}`, `tool-${callId}`, caller-provided for user messages.

**Tool call semantics:** `tool_call_delta` streams argument JSON fragments into `args`.
`tool_call_end.result` stores the execution result into `result`. These are separate
fields — args are what the model sends, result is what the tool returns.

**Tool payloads are capped:** 50KB tail-slice via `capOutput()`/`capResult()` — applies
to tool call args and tool results. Text and thinking blocks are unbounded because
they are user-facing content; memory is bounded by the 1000-message compaction.

## Views and Modals

Two-layer navigation: persistent **views** and transient **modals**.

| Type | Members | Behavior |
|------|---------|----------|
| View | `conversation`, `sessions`, `doctor`, `help`, `trajectory` | Screen-level, one active |
| Modal | `command-palette`, `permission-prompt`, `session-picker` | Overlay, preserves underlying view |

Modals are nullable. Dismissing returns to the underlying view without state loss.

## Actions

```typescript
type TuiAction =
  | { kind: "engine_event"; event: EngineEvent }    // coarse wrapper, no DRY violation
  | { kind: "add_user_message"; id: string; blocks: readonly ContentBlock[] }
  | { kind: "set_view"; view: TuiView }
  | { kind: "set_modal"; modal: TuiModal | null }
  | { kind: "set_connection_status"; status: ConnectionStatus }
  | { kind: "set_layout"; tier: LayoutTier }
  | { kind: "set_zoom"; level: number }
  | { kind: "add_error"; code: string; message: string }
  | { kind: "clear_messages" }
  | { kind: "permission_response"; requestId: string; decision: ApprovalDecision }
  // Phase 2j-4 — dispatched by host on session start; TUI never does I/O
  | { kind: "set_session_info"; modelName: string; provider: string; sessionName: string }
  | { kind: "set_session_list"; sessions: readonly SessionSummary[] }
  | { kind: "set_trajectory_data"; steps: readonly TrajectoryStepSummary[] }
```

`engine_event` wraps the full `EngineEvent` discriminated union from `@koi/core`.
The reducer internally switches on `event.kind`. No duplication of event variants.

`set_session_info` and `set_session_list` are injected by the CLI host. The TUI
package has zero file I/O and zero persistence — it is a pure rendering layer.

## Compaction

Append-only message list with **hysteresis** compaction:

- `MAX_MESSAGES = 1000` — target after compaction
- `COMPACT_THRESHOLD = 1100` — triggers compaction

When messages reach 1100, the reducer slices to the most recent 1000.
The 100-message gap prevents per-message array allocation at steady state.
Compaction runs on **all** message-append paths (user messages, `turn_start`,
and implicit assistant creation), not just user input.

## Store

Minimal API matching the `subscribe`/`getState` contract:

- `getState()` — always returns latest state (never stale, even during batched notify)
- `dispatch(action)` — applies reducer synchronously, coalesces notifications via `queueMicrotask`
- `dispatchBatch(actions)` — reduces N actions in one pass, notifies once synchronously. Used by EventBatcher flush to avoid N state updates + N signal invalidations per 16ms window.
- `subscribe(listener)` — returns unsubscribe function

**Microtask batching:** State updates are immediate; subscriber notifications are
coalesced. 50-100 text_delta dispatches/sec collapse into 1-3 notifications.
`dispatchBatch` is even more efficient — the EventBatcher flush callback maps all
events to actions and reduces them in a single loop before notifying.

**No-op guard:** If `reduce()` returns the same reference (`next === state`),
dispatch skips notification entirely.

## Performance Characteristics

| Concern | Strategy |
|---------|----------|
| Streaming deltas (50-100/sec) | Microtask-batched notifications |
| Message array updates | `Array.with()` for last-element clarity |
| Tool output growth | 50KB tail-slice cap (args + results) |
| Text/thinking growth | Unbounded (user-facing content, bounded by compaction) |
| No-op actions | Early return (same reference), store skips notify |
| Memory bounds | 1000-message cap with hysteresis |

## Edge Case Behavior

| Event | Reducer behavior |
|-------|-----------------|
| `text_delta` before `turn_start` | Creates implicit assistant message |
| `tool_call_end` without `tool_call_start` | No-op (drop silently) |
| `text_delta` + `tool_call_delta` interleaved | Accumulate to separate blocks |
| `done` mid-tool-call | `streaming=false`, running tools marked `"error"` |
| Empty `text_delta` (delta: `""`) | No-op |
| `turn_start` without prior `turn_end` | Auto-close previous turn |
| Duplicate `callId` | Update existing tool block |
| `add_error` without assistant | Creates implicit assistant + error block |
| `set_modal(null)` when already `null` | No-op (same reference) |
| `done` without `costUsd` | `cumulativeMetrics.costUsd` stays null |
| `done` with `costUsd` after null-cost turns | Treats prior null as 0, begins accumulating |
| `set_session_list` > 50 items | Truncated to 50 most-recent (`MAX_SESSIONS`) |
| `set_session_list` out-of-order | Sorted by `lastActivityAt` desc before storage |
| `plan_update` event | Replaces `planTasks` with mapped snapshot |
| `task_progress` event | Patches matching task in `planTasks`; no-op if `planTasks` is null |
| `set_trajectory_data` with steps | Replaces `trajectorySteps` with new data |
| Keypress drains after `EditBuffer` destroy on quit (#1744) | `InputArea` reads/writes go through `safeText`/`safeSetText`; `disposed` flag set on `onCleanup` short-circuits the `useKeyboard` callback so a stale `textareaRef` cannot throw `EditBuffer is destroyed` through the global `KeyHandler`. |

## Phase 2k: SolidJS Migration + Worker Infrastructure

Phase 2k migrated all 15 components from `@opentui/react` + React to `@opentui/solid` + SolidJS,
added a reactive store context layer, and introduced the batcher/worker infrastructure for the
main-thread ↔ Bun Worker bridge.

### Framework swap

All components now use `@opentui/solid` primitives. Build system changed from `tsup` to
`Bun.build` + `@opentui/solid/bun-plugin` so the Solid JSX transform is applied correctly
in `dist/`. A package-level `bunfig.toml` sets `conditions=["browser"]` and preloads Solid.

### Component pattern changes

- **Props access**: all components use `props.x` instead of destructured `({ x })` — destructuring kills Solid reactivity.
- **No `React.memo` / `useCallback`**: Solid components never re-render; stale-closure wrappers are not needed.
- **Control flow**: ternaries → `<Show>`, `.map()` → `<For>`, multi-branch → `<Switch><Match>`.

### TuiStateContext + createStoreSignal

Connecting TuiStore (imperative subscribe/getState) to Solid's fine-grained reactivity
requires a single shared signal per component tree to prevent torn reads across multiple
selectors.

- `createStoreSignal(store)` — creates one `Accessor<TuiState>` signal that drives the whole tree. Call once at tree root.
- `TuiStateContext` — Solid context carrying that accessor. `TuiRoot` creates the `TuiStateContext.Provider` internally.
- Both `TuiStateContext` and `createStoreSignal` are exported from the public barrel.

### EventBatcher (`src/batcher/event-batcher.ts`, ~70 LOC)

`createEventBatcher<T>` — rate-limiter between high-frequency Bun Worker messages and store
dispatches:

- 16ms `queueMicrotask` + `setTimeout` double-buffer (aligns with one frame budget).
- Injectable timer DI for deterministic testing (`options.scheduleTimeout` / `options.cancelTimeout`).
- `flushSync()` for ordered end-of-stream delivery (drains queue synchronously).
- Exports `TimerHandle = number | ReturnType<typeof setTimeout>` — a cross-environment union covering the browser `number` handle, Node.js `NodeJS.Timeout`, and Bun `Timer`. Both `scheduleTimeout` and `cancelTimeout` options use this type so the DTS build compiles cleanly even when `@types/bun` and `@types/node` are both present (they declare `setTimeout` with overlapping overloads).

### EngineChannel (`src/worker/engine-channel.ts`, ~120 LOC)

`createEngineChannel` — main-thread bridge: Bun Worker → EventBatcher → `store.dispatch`.

- Handles `approval_request` bidirectional flow (sends response back to worker).
- Calls `cancelAllApprovals` on worker failure so pending permission prompts are never stuck.
- `src/worker/_stub-worker.ts` provides a lightweight test stub.

## File Organization

```
packages/ui/tui/src/
├── state/
│   ├── types.ts           ~135 LOC  — all types, constants
│   ├── reduce.ts          ~345 LOC  — pure reducer + helpers
│   ├── store.ts           ~70 LOC   — createStore()
│   ├── initial.ts         ~18 LOC   — createInitialState()
│   ├── test-helpers.ts    ~90 LOC   — test factories
│   └── index.ts           ~15 LOC   — re-exports
├── components/
│   ├── text-block.tsx     ~20 LOC   — text/markdown renderer
│   ├── thinking-block.tsx ~15 LOC   — dimmed thinking display
│   ├── spinners.ts        ~45 LOC   — shared spinner presets + DEFAULT_SPINNER
│   ├── tool-call-block.tsx ~55 LOC  — tool lifecycle (spinner/result/error)
│   ├── error-block.tsx    ~30 LOC   — styled error display
│   ├── message-row.tsx    ~90 LOC   — turn router; <Switch><Match> for kind routing
│   ├── message-list.tsx   ~30 LOC   — scrollable conversation
│   ├── ConversationView.tsx ~50 LOC — MessageList + InputArea wrapper
│   ├── SessionsView.tsx   ~40 LOC   — sessions screen (reactive list + empty-state)
│   ├── DoctorView.tsx     ~45 LOC   — system health screen (inlined rows)
│   ├── HelpView.tsx       ~40 LOC   — help screen (static, zero store reads)
│   ├── TrajectoryView.tsx ~205 LOC  — ATIF trajectory viewer (scrollable, expandable steps)
│   └── index.ts           ~7 LOC    — re-exports
├── batcher/
│   └── event-batcher.ts   ~70 LOC   — createEventBatcher: 16ms rate-limiter + flushSync
├── worker/
│   ├── engine-channel.ts  ~120 LOC  — createEngineChannel: Worker → batcher → store bridge
│   └── _stub-worker.ts    —         test stub
├── store-context.tsx      ~35 LOC   — TuiStateContext, createStoreSignal, useTuiStore
├── tui-root.tsx           ~240 LOC  — TuiRoot + resolveNavCommand
├── create-app.ts          ~110 LOC  — createTuiApp() factory (16ms resize debounce)
├── build.ts               —         Bun.build script (also clears tsbuildinfo)
├── bunfig.toml            —         Solid preload + conditions=["browser"]
└── index.ts               ~80 LOC   — top-level re-exports (incl. CommandId, resolveNavCommand)
```

## Components

Eighteen components built on OpenTUI + SolidJS primitives:

| Component | Purpose | Key behavior |
|-----------|---------|-------------|
| `TextBlock` | Text/markdown | `<text>` baseline; `<markdown>` only when BOTH `syntaxStyle` AND `treeSitterClient` are provided. `<markdown>` without `treeSitterClient` blanks paragraph text — the guard prevents silent prose regression until tree-sitter is wired (#1542) |
| `ThinkingBlock` | Reasoning display | Dimmed/italic styling |
| `ToolCallBlock` | Tool lifecycle | Structured title/subtitle/chips display on completion; raw toolName during streaming. Result chips extracted from JSON results. `HighlightedText` helper for syntax-highlighted fallback |
| `ErrorBlock` | Error display | Red border, code + message |
| `MessageRow` | Turn router | `<Switch><Match>` for kind routing; no React.memo |
| `MessageList` | Conversation | `<scrollbox stickyScroll stickyStart="bottom">` — new messages always scroll into view; `stickyStart="bottom"` sets `_stickyScrollBottom=true` on init so the scrollbox follows the bottom rather than the top |
| `InputArea` | Text input | `<textarea>` with slash detection; Enter submits, Ctrl+J for newline |
| `SlashOverlay` | Slash completion | Fuzzy-filtered `<select>` dropdown; Escape dismisses |
| `PermissionPrompt` | HITL approval | Single-key (y/n/a/Esc) with risk-level color coding |
| `AskUserDialog` | Agent question | Multi-line `<textarea>`; Enter submits, Escape dismisses |
| `ConfirmDialog` | Yes/no prompt | Single-key (y/n/Esc) confirmation modal |
| `StatusBar` | Top/bottom info line | Model, tokens, cost, agentStatus, turn counter |
| `CommandPalette` | Ctrl+P fuzzy search | 15 commands, progressive disclosure, query via useKeyboard |
| `SessionPicker` | Session browser | Sorted list from `TuiState.sessions`, max 50 items |
| `SelectOverlay<T>` | Generic list selector | Shared primitive for palette and session picker |
| `SessionsView` | Sessions screen | Reactive list with empty-state fallback; `Ctrl+P → Resume session` hint |
| `DoctorView` | System health screen | Connection status, TTY detection, model, provider; inlined rows (no JSX-as-prop) |
| `HelpView` | Help screen | Static keybinding table + full `COMMAND_DEFINITIONS` list; zero store reads |
| `TrajectoryView` | ATIF execution trace | Interactive step list with arrow-key navigation, Enter expand/collapse, scrollable via `createScrollableList`. Shows kind, identifier, duration, outcome (color-coded), token metrics, and MW span metadata. Expanded steps show request/response/error content (capped at 2000 chars). Data injected by host via `set_trajectory_data` |

### Phase 2j-4: Status bar data flow

The status bar never re-renders on every streaming chunk:
- `useTuiStore(s => s.sessionInfo)` — stable reference, set once on session start
- `useTuiStore(s => s.cumulativeMetrics)` — updates only on `done` event (once per turn)
- `useTuiStore(s => s.agentStatus)` — updates on `turn_start`/`turn_end`/`done`/`add_error`

Token counts update at turn boundaries, not per-chunk. A `"streaming…"` label is
shown when `agentStatus === "processing"` to communicate that more tokens are pending.

### Phase 2j-4: Command palette

Progressive disclosure: commands with `minSessionCount > sessions.length` are hidden.
The `filterCommands(commands, sessionCount)` function is memoised on `sessionCount` in
the component — the expensive policy filter runs O(1 per new session), not per keystroke.
Fuzzy scoring (subsequence) runs per-keystroke against the already-filtered list (15 items, negligible cost).

Host wires `Ctrl+P` → `dispatch({ kind: "set_modal", modal: { kind: "command-palette", query: "" } })`.

## Store Hook

`useTuiStore(selector)` — returns a Solid `Accessor<T>`. The selector is applied reactively
inside a derived signal backed by `TuiStateContext`. Callers must invoke the accessor in JSX:

```typescript
const messages = useTuiStore(s => s.messages);
const view = useTuiStore(s => s.activeView);
// In JSX — call as a function:
// <For each={messages()}> ...
// <Show when={view() === "sessions"}> ...
```

`TuiRoot` creates `TuiStateContext.Provider` internally. Consumers only need
`<StoreContext.Provider value={store}>` at the tree root.

## Phase 2j-5: Root Component + Keyboard + Theme + Factory

Phase 2j-5 adds the final assembly layer on top of the state + components built in 2j-1 through 2j-4.

### New files

| File | Lines | Purpose |
|------|-------|---------|
| `src/key-event.ts` | ~25 | Shared key predicates (`isCtrlP`, `isCtrlC`, `isEscape`, etc.) |
| `src/theme.ts` | ~70 | Deep Water color tokens + layout helpers (no domain mappers) |
| `src/keyboard.ts` | ~70 | Pure `handleGlobalKey()` + `createKeyboardHandler()` |
| `src/components/ConversationView.tsx` | ~50 | Wrapper: MessageList + InputArea |
| `src/components/SessionsView.tsx` | ~40 | Sessions screen — reactive list with empty-state |
| `src/components/DoctorView.tsx` | ~45 | System health screen — connection, TTY, model, provider |
| `src/components/HelpView.tsx` | ~40 | Help screen — static keybindings + command list |
| `src/tui-root.tsx` | ~240 | Root component: StatusBar + views + modals + keyboard + nav routing |
| `src/create-app.ts` | ~110 | `createTuiApp()` factory |

### Key design decisions

**Two-layer keyboard (1A):** `TuiRoot` registers one `useKeyboard` for globals (Ctrl+P,
Ctrl+C, Esc). Modals register their own `useKeyboard` and guard with `if (!focused) return`.
Ctrl+C checks `renderer.getSelection()` first — if text is selected, it copies to clipboard
via OSC 52 and clears the selection instead of interrupting.
Esc priority: root checks `modal !== null` before calling `onDismissModal` vs `onBack`.

**State-driven layout tier (2A):** `TuiRoot` reads `layoutTier` from store. `createTuiApp`
installs a terminal resize listener and dispatches `set_layout` with 16ms debounce (aligns
with the batcher frame cadence). `TuiRoot` itself has zero terminal I/O.

**Single modal slot (3A):** `modal: TuiModal | null` — one modal at a time. Permission
prompt replaces palette (known limitation, intentional for v2 scope).

**Auto-mount factory (4A):** `createTuiApp(config)` does TTY check first (returns
`Result<TuiAppHandle, TuiStartError>`). Calling `handle.start()` mounts the renderer and
Solid component tree. `handle.stop()` is idempotent.

**Nav command interception:** `TuiRoot` intercepts `nav:sessions`, `nav:doctor`, `nav:help`,
and `nav:trajectory` from the command palette before they reach the CLI's `onCommand` callback.
Only engine-affecting commands (`agent:*`, `session:*`, `system:*`) bubble up. The pure helper
`resolveNavCommand(id)` maps command ID → `TuiView | null` and is exported for testing.

**`nav:trajectory` command:** Opens the ATIF execution trace view for the current session.
Added to `COMMAND_DEFINITIONS` in the `navigation` category.

### `createTuiApp` flow

```typescript
const result = createTuiApp({
  store,
  permissionBridge,
  onCommand,
  onSubmit,
  onInterrupt,
  syntaxStyle,       // optional — enables JSON highlighting in ToolCallBlock (<code>)
  treeSitterClient,  // optional — enables <markdown> in TextBlock (both required; see #1542)
})
if (!result.ok) {
  // result.error.kind === "no_tty" — not a terminal (CI, pipe, etc.)
  process.exit(1)
}
await result.value.start()   // mounts renderer + Solid tree, starts rendering
// ...
await result.value.stop()    // cleans up renderer, bridge, resize listener
```

`syntaxStyle` enables `<code>` syntax highlighting in tool call blocks and is the theme
object for eventual markdown rendering. `treeSitterClient` is the tree-sitter WASM client
required by `<markdown>` for paragraph/heading/prose rendering. Both are optional and
default to `undefined`. Pass both together to unlock rich assistant text rendering.
The `treeSitterClient` prop is threaded through the full component chain:
`CreateTuiAppConfig` → `TuiRoot` → `ConversationView` → `MessageList` → `MessageRow` →
`AssistantBlock` → `TextBlock`.

Solid-specific details:
- Uses `render()` + `createComponent()` from `@opentui/solid` (not React's `createRoot`).
- `solidRootDispose` is captured via `renderer.once()` intercept at mount time — no fake destroy event.
- A `stopGeneration` counter prevents a late `start()` re-animation after `stop()` has already begun its 5-second timeout.
- `render()` errors trigger full rollback (unmount + renderer teardown) before re-throwing.

### Theme

`theme.ts` contains only two concerns:

1. **`COLORS`** — the Deep Water palette as `as const` hex strings
2. **Layout + string helpers** — `computeLayoutTier(cols)`, `truncate`, `separator`, `abbreviateModel`

Domain-specific color decisions (agent status colors, connection indicator colors) live in
co-located component helpers (e.g., `status-bar-helpers.ts`, `PermissionPrompt.tsx`), not
in `theme.ts`. The `CONNECTION_STATUS_CONFIG` lookup table in `theme.ts` is an exception
because it is a pure structural invariant with no domain business logic.

**Layout tier breakpoints:**

| Cols | Tier | What changes |
|------|------|-------------|
| < 60 | `compact` | Metrics hidden, minimal decoration |
| 60-119 | `normal` | Standard layout |
| ≥ 120 | `wide` | Full layout |

### `TuiRoot` selector discipline

`TuiRoot` only subscribes to the two fields it needs for routing:
```typescript
const activeView = useTuiStore((s) => s.activeView)  // reactive only on navigation
const modal = useTuiStore((s) => s.modal)            // reactive only on modal open/close
```
Zero re-renders during streaming. StatusBar, MessageList, InputArea each manage their own
subscriptions.

### Error handling

| Failure | Handling |
|---------|----------|
| `process.stdout.isTTY === false` | `createTuiApp` returns `{ ok: false, error: { kind: "no_tty" } }` |
| `createCliRenderer()` throws | `handle.start()` throws `Error("Failed to start TUI renderer", { cause })` |
| `render()` throws | Full rollback: unmount + renderer teardown before re-throw |
| `stop()` before `start()` | No-op (idempotent) |
| `stop()` called twice | No-op (idempotent) |

## Layer Compliance

- State layer imports only from `@koi/core` (EngineEvent, ContentBlock, ToolCallId)
- Component layer imports from `@koi/core` + `@opentui/core` + `@opentui/solid` + `solid-js`
- No imports from `@koi/engine`, peer L2, or external state libraries

> **Maintenance note (PR #1506):** Added `biome-ignore lint/style/noNonNullAssertion` annotation to `event-batcher.test.ts` timer access that is bounds-guaranteed by construction. No functional changes.

> **PR #1508 — App shell wiring (#1459):** Added `SessionsView`, `DoctorView`, `HelpView`. `TuiRoot` now intercepts nav commands (palette → `set_view`) and renders real view components via `<Switch><Match>`. `resolveNavCommand()` and `CommandId` exported. Resize debounce changed 50ms → 16ms. `build.ts` now clears `tsconfig.tsbuildinfo` before tsc declaration emit to prevent incremental-cache skip of subpath `.d.ts` files. `StatusBar.ModelChip` fixed: nested `<text>` inside `<text>` is invalid in OpenTUI — replaced with `<box flexDirection="row">` + three sibling `<text>` elements.

> **Current branch — Slash overlay double-submit fix + InputArea guards:** Fixed a race condition where pressing Enter on the slash overlay would also submit the "/" text to the engine. Root cause: the `disabled` prop path relied on `queueMicrotask`-deferred store notifications, creating a two-hop async delay before `InputArea` saw the updated state. Fix: `InputArea`'s submit handler now calls `detectSlashPrefix(result.text)` synchronously — if the text has a slash prefix the submit is suppressed regardless of reactive state or input batching. `ConversationView` no longer sets `disabled` on `InputArea` (it was freezing the slash query at "/" and preventing filter typing). The `disabled` prop remains in the interface for other callers.

> **PR #1535 — DRY scroll primitives, syntax highlighting, test coverage, overlay opacity:**
>
> **`createScrollableList` (select-overlay-helpers.ts):** Extracted `computeVisibleStart` as a pure function for unit testing. `selectedIdx` clamping moved from `createEffect` to `createMemo` — `createEffect` defers to the next microtask which causes `selectedIdx()` to return stale values in synchronous test assertions. `createMemo` computes inline and is always consistent. Fixed `moveDown` on an empty list: previously wrote `-1` to `rawIdx` (upper-bound-only clamp missed the lower bound); now guards `max < 0 ? 0 : Math.min(i+1, max)`.
>
> **`TextBlock` (text-block.tsx):** `<markdown>` is now gated on BOTH `syntaxStyle` AND `treeSitterClient`. Previously, `<markdown>` activated on `syntaxStyle` alone, but `<markdown>` without `treeSitterClient` silently renders blank paragraph/heading text (only code fences show). The dual-guard restores the prose-renders-correctly invariant: the component falls back to `<text>` when tree-sitter is absent. `treeSitterClient?: TreeSitterClient | undefined` added to `TextBlockProps` and threaded through the entire prop chain down from `CreateTuiAppConfig`. Once `treeSitterClient` is wired in the CLI (#1542), rich markdown rendering activates automatically.
>
> **Modal overlay opacity (theme.ts, ConversationView.tsx):** `MODAL_POSITION` constant gained `backgroundColor: "#0D1B2A"` (the `bgElevated` Deep Water color as a literal, required by `--isolatedDeclarations`). `SlashOverlay`'s wrapper box in `ConversationView` now uses `backgroundColor={COLORS.bgElevated}`. These fixes prevent modal content bleeding through transparent overlay regions.

> **Trajectory view (current branch):** Added `TrajectoryView` component, `"trajectory"` view type, `TrajectoryStepSummary` and `TrajectoryMiddlewareSpan` types, `set_trajectory_data` action, and `nav:trajectory` command palette entry. The host injects trajectory step summaries via `set_trajectory_data`; the TUI renders an interactive step list with arrow-key navigation, Enter expand/collapse, outcome coloring, token metrics, and MW span annotations. `TuiState.trajectorySteps` stores the data; `TuiRoot` routes the `"trajectory"` view to `TrajectoryView`.

> **Spinner config unified (current branch):** Extracted the braille spinner frames and tick interval from `ToolCallBlock`, `MessageRow`, and `MessageList` into a shared `src/components/spinners.ts`. Ships five presets (`braille`, `dots`, `line`, `arc`, `circle`) as `Readonly<Record<SpinnerName, Spinner>>` and a `DEFAULT_SPINNER` pointer. `ToolCallBlock` (running tool) and `MessageRow` (thinking indicator) both read from `DEFAULT_SPINNER.frames`; `MessageList` derives its `SPINNER_FRAME_COUNT` and `SPINNER_INTERVAL_MS` from `DEFAULT_SPINNER.frames.length` and `DEFAULT_SPINNER.intervalMs` so the single global `spinnerFrame` tick loop auto-adjusts when the default preset is swapped. No behavior change: default stays `braille`. Note: the `as const satisfies Record<string, Spinner>` pattern was rejected by `isolatedDeclarations` for exported consts, so the module uses a declared `SpinnerName` union plus `Readonly<Record<SpinnerName, Spinner>>` annotation instead.

> **Persistent approval UI (#1622):** `PermissionPromptData` now includes an optional `permanentAvailable` boolean. When true, `PermissionPrompt.tsx` renders an additional `[!] Always (permanent)` key that emits `{ kind: "always-allow", scope: "always" }`. `createPermissionBridge` accepts a `permanentAvailable` option that plumbs the flag into every prompt. The TUI runtime sets this flag when a persistent approval store is configured.

> **#1583 — TUI feature parity (20 features) + spawn infrastructure:**
>
> **Tool block polish:** `tool_call` blocks now carry `startedAt` (set on `tool_call_start`) and `durationMs` (set on `tool_result`). `StatusIndicator` migrated from a plain `switch(props.status)` to SolidJS `<Switch><Match>` so status reactively transitions from "running" → "complete" instead of being captured at mount. Running tools display elapsed time inline next to the spinner; completed tools display a duration chip alongside arg/result chips. The `tool_call_end` handler is now a no-op for status — only `tool_result` marks the block complete and decrements `runningToolCount` (long-running tools no longer flip to ✓ before the tool actually executes).
>
> **N-line truncation:** New `expandedBodyToolCallIds: ReadonlySet<string>` state field plus `expand_tool_body` / `collapse_tool_body` actions. `ToolCallBlock` truncates the result body to a per-tool line cap (Bash/shell/run = 10 lines, default = 3) when the accordion is open; clicking the "… N more lines (click to expand)" affordance dispatches `expand_tool_body`.
>
> **StatusBar additions:** New state fields `maxContextTokens` (set via `set_session_info.maxTokens`), `retryState` (set via `set_retry_state` action), `agentDepth` and `siblingInfo` (set via `set_agent_context`). StatusBar renders `ctx N%` when context tokens are known, `Retrying in Ns (attempt M)` when retryState is set, and `Subagent (current of total)` when nesting depth > 0. All hidden by default — only render when their backing field is non-null.
>
> **Error JSON unwrapping:** `add_error` reducer/mutation now deep-parses JSON-encoded error messages (single- and double-encoded), extracting `.message` or `.error` fields before storing the error block. Pure helper `unwrapErrorMessage` shared between `reduce.ts` and `mutations.ts`.
>
> **InputArea — @-mention + image paste:** New `atQuery: string | null` and `atResults: readonly string[]` state. `InputArea` detects `@<partial>` prefix on each keystroke and dispatches `set_at_query`; new `AtOverlay.tsx` component renders file completions via `SelectOverlay`. Ctrl+V invokes `readClipboardImage()` from `src/utils/clipboard.ts` which calls platform-native APIs (`osascript` on macOS, `wl-paste`/`xclip` on Linux, PowerShell on Windows) to read raw PNG bytes from the clipboard, base64-encodes them as a `data:image/png;base64,…` URI, and pushes them into a local `attachedImages` signal. The new `onImageAttach?: (image) => void` prop on `InputArea`/`ConversationView`/`TuiRoot` lets the host (tui-command.ts) collect images for inclusion as `image` ContentBlocks in the next `add_user_message` dispatch.
>
> **Sub-agent rendering — `SpawnBlock` + AgentsView:** New `spawn_call` `TuiAssistantBlock` variant carrying `agentId`, `agentName`, `description`, `status: "running" | "complete" | "failed"`, and optional `stats: { turns; toolCalls; durationMs }`. New `activeSpawns: ReadonlyMap<string, SpawnProgress>` state tracking live spawn progress (agentName, description, startedAt, optional currentTool). The reducer creates a `spawn_call` block on `spawn_requested` engine events and a new dedicated `set_spawn_terminal` action (with explicit `complete | failed` outcome) marks blocks terminal — using `agent_status_changed` would collapse failures into successes because the engine's `ProcessState` only has a single `"terminated"` value. New `SpawnBlock.tsx` component renders the inline spawn (status icon + agentName + description + duration); clicking a completed spawn dispatches `set_view: "sessions"` for navigation. New `AgentsView.tsx` plus `"agents"` view kind and `nav:agents` command palette entry render the live `activeSpawns` map as a list with elapsed time and current activity.
>
> **Session UX — fork + rename:** New `"session-rename"` modal kind, new `SessionRename.tsx` component (textarea pre-filled with current `sessionInfo.sessionName`), `session:rename` and `session:fork` commands in `command-definitions.ts`. The host wires `onFork` and `session:rename:<name>` commands via `TuiRoot`'s callback props; `tui-command.ts` implements fork by loading the active session's transcript entries via `jsonlTranscript.load(runtime.sessionId)` and writing them to a fresh session file with `jsonlTranscript.append(crypto.randomUUID(), entries)` — the active session continues uninterrupted and the fork shows up in the session picker on next refresh.
>
> **`onTurnComplete` callback:** New `TuiRootProps.onTurnComplete?: () => void` fires when `agentStatus` transitions `processing → idle`. The host wires this to `process.stdout.write("\x07")` (BEL) for terminal notification.
>
> **Ctrl+E reactivity fix:** `expandedToolCallIds: ReadonlySet<string>` (not the previous boolean toggle) lets per-block expansion track per `callId`. New `expand_tool` / `collapse_tool` / `toggle_all_tools_expanded` actions. `ToolCallBlock` reads `state.expandedToolCallIds.has(callId)` so each tool block has independent expand state.
>
> **`set_spawn_terminal` action:** Dedicated TUI action carrying explicit `outcome: "complete" | "failed"` for spawn lifecycle endings. The TUI bridge dispatches this instead of routing through `engine_event` because the engine's `agent_status_changed.status` is `ProcessState`, which only has a single `"terminated"` value — passing through the engine event path would lose the success/failure distinction.
>
> **`onSpawnEvent` side-channel (host-injected):** The TUI's spawn provider config (`createSpawnToolProvider({ onSpawnEvent })`) emits a synchronous `spawn_requested` event before the child runs and an `agent_status_changed` event after, both via a callback rather than the engine event stream (the spawn tool's `execute()` runs inside the parent's `runtime.run()` and can't yield events into that stream). The host bridge dispatches these into the TUI store as `engine_event` and `set_spawn_terminal` actions respectively.

> **Checkpoint rewind (`/rewind [n]` slash command):** Added `/rewind` slash command that rolls back conversation state to a prior checkpoint. `onSlashSelect` now passes args (the optional step count `n`) through to the host callback, enabling parameterized slash commands. `ConversationView` shows a checkpoint hint after each checkpoint-eligible turn so users know rewind is available. The `/rewind` command dispatches through the existing `onCommand` callback with the step count argument.

> **Copy-on-select + Ctrl+C copy:** Text selection now auto-copies to clipboard via OSC 52 when the mouse drag finishes (same pattern as OpenCode). `MessageList.useSelectionHandler` extracts `selection.getSelectedText()`, calls `copyToClipboard()`, then `renderer.clearSelection()` + `onSelectionEnd()` to restore auto-follow. Ctrl+C fallback in `TuiRoot`: reads `renderer.getSelection()`, copies if non-empty, clears selection and dispatches `resume_follow` to re-enable auto-scroll (since `renderer.clearSelection()` does not emit a null selection event). If copy fails (non-TTY or payload exceeds `MAX_CLIPBOARD_BYTES`), Ctrl+C falls through to interrupt. New `resumeFollowCounter` state field bridges the Ctrl+C path to MessageList's scroll state. `<text>` elements in `message-row.tsx` and `text-block.tsx` set `selectable` explicitly; `<markdown>` elements use `ref={enableSelection}` to set `selectable = true` imperatively (MarkdownRenderable inherits `false` from Renderable and `MarkdownProps` doesn't expose the typed prop). `copyToClipboard()` now enforces `MAX_CLIPBOARD_BYTES` on the base64-encoded payload length before writing.
>
> **#1689 — Stdin-parser reset after permission prompt:** `createTuiApp` subscribes to the store after a successful `render()` and, on `permission-prompt → null` modal transitions, invokes `renderer.stdinParser?.reset?.()`. Root cause lives in `@opentui/core@0.1.96`'s stdin parser (`index-vy1rm1x3.js`): a permission-approval keystroke sequence can leave the parser's `paste` latch set or its pending ByteQueue armed with stale bytes, at which point `tryForceFlush` (L7240) short-circuits and Enter / Backspace / Esc / Tab bytes never reach `_keyHandler.processParsedKey`. Printable characters still arrive because they take a separate fast path in the state machine. Calling the parser's public `reset()` (L7251) clears `pending`, `pendingSinceMs`, `paste`, and the parser state back to `ground` — it is the only operation that explicitly drops the paste latch. The subscriber is wired inside `create-app.ts` rather than `TuiRoot` because the renderer handle lives at the mount layer and this is a transport concern, not a view concern. Scope is intentionally limited to `permission-prompt` transitions: no other modal has exhibited the same class of bug, and extending the reset to every modal close would hide future parser regressions behind a blanket workaround. If a second modal is reported dropping keys, add its `kind` to the transition guard in `create-app.ts` rather than resetting on every modal clear. The subscribe unsubscribe handle is captured into the mount cleanup closure so `stop()` drops the listener alongside `cleanupResize`. Unit-testable with an injected fake renderer exposing `{ stdinParser: { reset: mock() } }`; see `create-app.test.ts`.

> **Per-turn collapsible trajectory view (PR #1758):** `TrajectoryView` rewritten from a flat step list to a two-level collapsible tree grouped by user turn. `TrajectoryStepSummary` gains `readonly turnIndex: number` (0 = setup, 1+ = user turns). Turn headers show aggregate metrics (step count, duration, tokens in/out) and toggle expand/collapse with Enter. Steps render indented under their turn header with per-step detail expansion. `createEffect(on(turns, ...))` auto-expands each new turn as it appears during live sessions. Synthetic `koi:tui_turn_start` boundary steps (injected by the CLI before each `run()`) are filtered from the display. `createScrollableList` reused unchanged — it navigates the interleaved flat list of turn headers + step rows.
