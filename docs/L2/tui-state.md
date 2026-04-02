# @koi/tui — State Layer

> TUI rendering state: types, reducer, and store for the Ink-based terminal UI.

**Layer:** UI (depends on `@koi/core` only)
**Location:** `packages/ui/tui/src/state/`
**Issue:** #1265 (Phase 2j-1)

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
    useSyncExternalStore (React 18+)
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
}
```

Six flat fields. No nesting, no grouping. Rule of Three: group only at 12+ fields.

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
      status: "running" | "complete" | "error"; output?: string }
```

**IDs are deterministic:** `assistant-${turnIndex}`, `tool-${callId}`, caller-provided for user messages.

**Tool output is capped:** 50KB tail-slice per tool call to prevent memory bloat.

## Views and Modals

Two-layer navigation: persistent **views** and transient **modals**.

| Type | Members | Behavior |
|------|---------|----------|
| View | `conversation`, `sessions`, `doctor`, `help` | Screen-level, one active |
| Modal | `command-palette`, `permission-prompt` | Overlay, preserves underlying view |

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
  | { kind: "clear_messages" }
```

`engine_event` wraps the full `EngineEvent` discriminated union from `@koi/core`.
The reducer internally switches on `event.kind`. No duplication of event variants.

## Compaction

Append-only message list with **hysteresis** compaction:

- `MAX_MESSAGES = 1000` — target after compaction
- `COMPACT_THRESHOLD = 1100` — triggers compaction

When messages exceed 1100, the reducer slices to the most recent 1000.
The 100-message gap prevents per-message array allocation at steady state.

## Store

Minimal API matching `useSyncExternalStore` contract:

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
| Tool output growth | 50KB tail-slice cap |
| No-op actions | Early return (same reference), store skips notify |
| Memory bounds | 1000-message cap with hysteresis |

## Edge Case Behavior

| Event | Reducer behavior |
|-------|-----------------|
| `text_delta` before `turn_start` | Creates implicit assistant message |
| `tool_call_end` without `tool_call_start` | No-op (drop silently) |
| `text_delta` + `tool_call_delta` interleaved | Accumulate to separate blocks |
| `done` mid-tool-call | `streaming=false`, tool stays `"running"` |
| Empty `text_delta` (delta: `""`) | No-op |
| `turn_start` without prior `turn_end` | Auto-close previous turn |
| Duplicate `callId` | Update existing tool block |

## File Organization

```
packages/ui/tui/src/state/
├── types.ts      ~120 LOC  — all types, constants
├── reduce.ts     ~150 LOC  — pure reducer + helpers
├── store.ts      ~50 LOC   — createStore()
├── initial.ts    ~30 LOC   — createInitialState()
└── index.ts      ~15 LOC   — re-exports
```

## Layer Compliance

- Imports only from `@koi/core` (EngineEvent, ContentBlock, ToolCallId)
- No imports from `@koi/engine`, peer L2, or external state libraries
- No runtime dependencies beyond `@koi/core`
