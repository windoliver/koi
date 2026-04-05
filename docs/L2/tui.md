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
│  TuiStore            │  ← thin wrapper (~50 LOC)
│  - getState()        │     always returns latest state
│  - dispatch(action)  │     applies reducer + microtask-batched notify
│  - subscribe(fn)     │     returns unsubscribe function
└──────────────────────┘
           │
           ▼
┌──────────────────────┐
│  TuiStateContext      │  ← one shared reactive signal per component tree
│  createStoreSignal()  │     adapts TuiStore → Solid Accessor<TuiState>
│  useTuiStore(sel)     │     returns Accessor<T> (call as sel() in JSX)
└──────────────────────┘
```

## State Shape

```typescript
interface TuiState {
  readonly messages: readonly TuiMessage[];
  readonly activeView: TuiView;
  readonly modal: TuiModal | null;
  readonly connectionStatus: ConnectionStatus;
  readonly layoutTier: LayoutTier;
  readonly zoomLevel: number;
  // Status bar data (Phase 2j-4)
  readonly sessionInfo: SessionInfo | null;       // set by host on session start
  readonly cumulativeMetrics: CumulativeMetrics;  // accumulated across all turns
  readonly agentStatus: AgentStatus;              // idle | processing | error
  // Session picker data (Phase 2j-4)
  readonly sessions: readonly SessionSummary[];   // sorted most-recent-first, max 50
}
```

Ten flat fields. Rule of Three: group only at 12+ fields.

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
      result?: unknown } // tool execution result from tool_call_end
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
| View | `conversation`, `sessions`, `doctor`, `help` | Screen-level, one active |
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
- `subscribe(listener)` — returns unsubscribe function

**Microtask batching:** State updates are immediate; subscriber notifications are
coalesced. 50-100 text_delta dispatches/sec collapse into 1-3 notifications.

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
│   ├── tool-call-block.tsx ~55 LOC  — tool lifecycle (spinner/result/error)
│   ├── error-block.tsx    ~30 LOC   — styled error display
│   ├── message-row.tsx    ~90 LOC   — turn router; <Switch><Match> for kind routing
│   ├── message-list.tsx   ~30 LOC   — scrollable conversation
│   ├── ConversationView.tsx ~50 LOC — MessageList + InputArea wrapper
│   ├── SessionsView.tsx   ~40 LOC   — sessions screen (reactive list + empty-state)
│   ├── DoctorView.tsx     ~45 LOC   — system health screen (inlined rows)
│   ├── HelpView.tsx       ~40 LOC   — help screen (static, zero store reads)
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
| `TextBlock` | Text/markdown | `<text>` baseline, `<markdown>` when syntaxStyle provided |
| `ThinkingBlock` | Reasoning display | Dimmed/italic styling |
| `ToolCallBlock` | Tool lifecycle | Spinner while running, checkmark on complete, X on error |
| `ErrorBlock` | Error display | Red border, code + message |
| `MessageRow` | Turn router | `<Switch><Match>` for kind routing; no React.memo |
| `MessageList` | Conversation | `<scrollbox>` with stickyScroll, uses `useTuiStore(s => s.messages)` |
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
Esc priority: root checks `modal !== null` before calling `onDismissModal` vs `onBack`.

**State-driven layout tier (2A):** `TuiRoot` reads `layoutTier` from store. `createTuiApp`
installs a terminal resize listener and dispatches `set_layout` with 16ms debounce (aligns
with the batcher frame cadence). `TuiRoot` itself has zero terminal I/O.

**Single modal slot (3A):** `modal: TuiModal | null` — one modal at a time. Permission
prompt replaces palette (known limitation, intentional for v2 scope).

**Auto-mount factory (4A):** `createTuiApp(config)` does TTY check first (returns
`Result<TuiAppHandle, TuiStartError>`). Calling `handle.start()` mounts the renderer and
Solid component tree. `handle.stop()` is idempotent.

**Nav command interception:** `TuiRoot` intercepts `nav:sessions`, `nav:doctor`, `nav:help`
from the command palette before they reach the CLI's `onCommand` callback. Only engine-affecting
commands (`agent:*`, `session:*`, `system:*`) bubble up. The pure helper `resolveNavCommand(id)`
maps command ID → `TuiView | null` and is exported for testing.

### `createTuiApp` flow

```typescript
const result = createTuiApp({ store, permissionBridge, onCommand, onSubmit, onInterrupt })
if (!result.ok) {
  // result.error.kind === "no_tty" — not a terminal (CI, pipe, etc.)
  process.exit(1)
}
await result.value.start()   // mounts renderer + Solid tree, starts rendering
// ...
await result.value.stop()    // cleans up renderer, bridge, resize listener
```

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
