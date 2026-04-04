/**
 * CommandPalette — Ctrl+P fuzzy-search overlay for commands.
 *
 * Architecture:
 *  - Query state is local (transient; not persisted to TuiState).
 *  - useKeyboard captures printable chars + Backspace to update query.
 *    Arrow keys and Enter are NOT prevented → passed through to <select>.
 *  - Progressive disclosure filtering is memoised on sessionCount.
 *  - Fuzzy scoring runs per-keystroke (15 items: negligible cost).
 */

import type { KeyEvent } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import React, { memo, useCallback, useMemo, useState } from "react";
import {
  COMMAND_DEFINITIONS,
  filterCommands,
  type CommandDef,
} from "../commands/command-definitions.js";
import { fuzzyFilter } from "../commands/fuzzy-match.js";
import { useTuiStore } from "../store-context.js";
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

    const sessionCount = useTuiStore((s) => s.sessions.length);
    const [query, setQuery] = useState("");

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
            setQuery((prev: string) => prev.slice(0, -1));
            return;
          }
          // Single printable character (no Ctrl, no Meta modifier)
          if (key.sequence && key.sequence.length === 1 && !key.ctrl && !key.meta) {
            key.preventDefault();
            setQuery((prev: string) => prev + key.sequence);
          }
        },
        [focused, onClose],
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
