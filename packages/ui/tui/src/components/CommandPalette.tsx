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
import { useKeyboard } from "@opentui/react";
import React, { memo, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import {
  COMMAND_DEFINITIONS,
  filterCommands,
  type CommandDef,
} from "../commands/command-definitions.js";
import { fuzzyFilter } from "../commands/fuzzy-match.js";
import { StoreContext, useTuiStore } from "../store-context.js";
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

export const CommandPalette: React.NamedExoticComponent<CommandPaletteProps> = memo(
  function CommandPalette(props: CommandPaletteProps): React.ReactNode {
    const { onSelect, onClose, focused } = props;

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
    const queryRef = useRef(storedQuery);
    const [query, setQuery] = useState(storedQuery);

    // When the bridge restores the modal (e.g., after a permission-prompt
    // clears and the palette is re-shown with a stored query), resync local
    // state so the displayed query matches the restored value.
    useEffect(() => {
      if (storedQuery !== queryRef.current) {
        queryRef.current = storedQuery;
        setQuery(storedQuery);
      }
    }, [storedQuery]);

    const updateQuery = useCallback(
      (next: string) => {
        queryRef.current = next; // synchronous — no React batching
        setQuery(next);          // trigger re-render
        // Guard: only write to the modal slot when we still own it.
        // A permission prompt may have taken over between keystrokes; never
        // let a stale keystroke replace an active approval dialog.
        if (store?.getState().modal?.kind === "command-palette") {
          store.dispatch({ kind: "set_modal", modal: { kind: "command-palette", query: next } });
        }
      },
      [store],
    );

    // Memoised: recomputes only when sessionCount changes (not on every keystroke)
    const sessionFiltered = useMemo(
      () => filterCommands(COMMAND_DEFINITIONS, sessionCount),
      [sessionCount],
    );

    // Per-keystroke fuzzy filter (15 items, negligible cost — no memoisation needed)
    const items =
      query.length === 0
        ? sessionFiltered
        : fuzzyFilter(sessionFiltered, query, getCommandLabel);

    // Capture printable chars + Backspace to build the query.
    // queryRef.current (not the render-time `query`) is used to compute the next
    // value so bursty key events sequence correctly even before a re-render commits.
    // Arrow keys and Enter are NOT prevented so <select> handles navigation.
    useKeyboard(
      useCallback(
        (key: KeyEvent) => {
          if (!focused) return;
          if (key.name === "escape") {
            key.preventDefault();
            onClose();
            return;
          }
          if (key.name === "backspace") {
            key.preventDefault();
            updateQuery(queryRef.current.slice(0, -1));
            return;
          }
          // Single printable character (no Ctrl, no Meta modifier)
          if (key.sequence && key.sequence.length === 1 && !key.ctrl && !key.meta) {
            key.preventDefault();
            updateQuery(queryRef.current + key.sequence);
          }
        },
        [focused, onClose, updateQuery],
      ),
    );

    return (
      <box
        flexDirection="column"
        border={true}
        borderColor="#60A5FA"
        width={60}
        position="absolute"
        top={1}
        left={2}
        zIndex={20}
      >
        {/* Header */}
        <box paddingLeft={1} paddingTop={1}>
          <text fg="#60A5FA">
            <b>{"Commands"}</b>
          </text>
        </box>

        {/* Search query display */}
        <box paddingLeft={1} paddingBottom={1}>
          <text fg="#64748B">{"/ "}</text>
          <text fg="#E2E8F0">{query}</text>
          {focused ? <text fg="#60A5FA">{"▌"}</text> : null}
        </box>

        {/* Command list */}
        <SelectOverlay
          items={items}
          getLabel={getCommandLabel}
          getDescription={getCommandDescription}
          onSelect={onSelect}
          onClose={onClose}
          focused={focused}
          emptyText="No matching commands"
        />
      </box>
    );
  },
);
