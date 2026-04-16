/**
 * CommandPalette — Ctrl+P fuzzy-search overlay for commands.
 *
 * Architecture:
 *  - Query is sourced from modal state (`TuiModal.query`) so it survives
 *    interruptions (e.g., a permission prompt taking over the modal slot).
 *  - useKeyboard captures printable chars + Backspace to update query;
 *    each change is also persisted back to the store via set_modal.
 *  - Arrow keys and Enter are NOT prevented → passed through to <select>.
 *  - Progressive disclosure filtering is memoised on sessionCount.
 *  - Fuzzy scoring runs per-keystroke (15 items: negligible cost).
 */

import type { KeyEvent } from "@opentui/core";
import { useKeyboard } from "@opentui/solid";
import type { JSX } from "solid-js";
import { createMemo, createEffect, createSignal, Show, useContext } from "solid-js";
import {
  COMMAND_DEFINITIONS,
  filterCommands,
  type CommandDef,
} from "../commands/command-definitions.js";
import { fuzzyFilter } from "../commands/fuzzy-match.js";
import { StoreContext, useTuiStore } from "../store-context.js";
import { COLORS, MODAL_POSITION } from "../theme.js";
import { SelectOverlay } from "./SelectOverlay.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CommandPaletteProps {
  /** Called when the user selects a command. */
  readonly onSelect: (command: CommandDef) => void;
  /** Called when the user dismisses the palette (Escape). */
  readonly onClose: () => void;
  /** Whether the palette has keyboard focus. */
  readonly focused: boolean;
}

// ---------------------------------------------------------------------------
// Label / description extractors
// ---------------------------------------------------------------------------

const getCommandLabel = (cmd: CommandDef): string => cmd.label;
const getCommandDescription = (cmd: CommandDef): string => cmd.description;

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function CommandPalette(props: CommandPaletteProps): JSX.Element {
  const store = useContext(StoreContext);
  const sessionCount = useTuiStore((s) => s.sessions.length);

  // Source the initial query from modal state so a restored palette has the
  // query that was active before a permission-prompt interruption.
  const storedQuery = useTuiStore((s) =>
    s.modal?.kind === "command-palette" ? s.modal.query : "",
  );

  // queryRef is the synchronous source of truth for rapid keystroke sequences.
  // Updating the ref + store happens immediately in the key handler, so the
  // permission bridge (which reads store state synchronously) always sees the
  // latest query when snapshotting before a permission-prompt takeover.
  let queryRef = storedQuery();
  const [query, setQuery] = createSignal(storedQuery());

  // Reconcile when storedQuery changes (bridge restore or first mount).
  //
  // Two cases:
  // A) We own the modal (just restored) and local state is ahead of the store
  //    (user typed during the interruption). Persist local value to the store —
  //    our value is more recent and should win.
  // B) We don't own the modal (being initialized or externally driven). Adopt
  //    the stored value so the displayed query stays in sync.
  //
  // This makes the interruption handoff atomic from the user's perspective:
  // characters typed while the permission prompt was showing are preserved
  // when the palette comes back.
  createEffect(() => {
    const sq = storedQuery();
    if (sq === queryRef) return; // already in sync
    if (store?.getState().modal?.kind === "command-palette") {
      // We own the modal — persist our (more recent) local query to the store
      store.dispatch({
        kind: "set_modal",
        modal: { kind: "command-palette", query: queryRef },
      });
    } else {
      // We don't own the modal — adopt the stored value
      queryRef = sq;
      setQuery(sq);
    }
  });

  const updateQuery = (next: string): void => {
    queryRef = next; // synchronous — no batching issues
    setQuery(next);  // trigger re-render
    // Guard: only write to the modal slot when we still own it.
    // A permission prompt may have taken over between keystrokes; never
    // let a stale keystroke replace an active approval dialog.
    if (store?.getState().modal?.kind === "command-palette") {
      store.dispatch({ kind: "set_modal", modal: { kind: "command-palette", query: next } });
    }
  };

  // Memoised: recomputes only when sessionCount changes (not on every keystroke)
  const sessionFiltered = createMemo(
    () => filterCommands(COMMAND_DEFINITIONS, sessionCount()),
  );

  // Per-keystroke fuzzy filter (15 items, negligible cost — no memoisation needed)
  const items = createMemo(() => {
    const q = query();
    return q.length === 0
      ? sessionFiltered()
      : fuzzyFilter(sessionFiltered(), q, getCommandLabel);
  });

  // Capture printable chars + Backspace to build the query.
  // queryRef (not the render-time query()) is used to compute the next
  // value so bursty key events sequence correctly even before a re-render commits.
  // Arrow keys and Enter are NOT prevented so <select> handles navigation.
  useKeyboard((key: KeyEvent) => {
    if (!props.focused) return;
    if (key.name === "escape") {
      key.preventDefault();
      props.onClose();
      return;
    }
    if (key.name === "backspace") {
      key.preventDefault();
      updateQuery(queryRef.slice(0, -1));
      return;
    }
    // Single printable character (no Ctrl, no Meta modifier).
    // Exclude Enter (\r) and Tab (\t) — those are navigation keys handled
    // by SelectOverlay and must not be consumed as query characters.
    if (
      key.sequence &&
      key.sequence.length === 1 &&
      !key.ctrl &&
      !key.meta &&
      key.name !== "return" &&
      key.name !== "tab"
    ) {
      key.preventDefault();
      updateQuery(queryRef + key.sequence);
    }
  });

  return (
    <box
      flexDirection="column"
      border={true}
      borderColor={COLORS.blueAccent}
      width={60}
      {...MODAL_POSITION}
    >
      {/* Header */}
      <box paddingLeft={1} paddingTop={1}>
        <text fg={COLORS.blueAccent}>
          <b>{"Commands"}</b>
        </text>
      </box>

      {/* Search query display */}
      <box paddingLeft={1} paddingBottom={1}>
        <text fg={COLORS.textMuted}>{"/ "}</text>
        <text fg={COLORS.white}>{query()}</text>
        <Show when={props.focused}>
          <text fg={COLORS.blueAccent}>{"▌"}</text>
        </Show>
      </box>

      {/* Command list */}
      <SelectOverlay
        items={items()}
        getLabel={getCommandLabel}
        getDescription={getCommandDescription}
        onSelect={props.onSelect}
        onClose={props.onClose}
        focused={props.focused}
        emptyText="No matching commands"
      />
    </box>
  );
}
