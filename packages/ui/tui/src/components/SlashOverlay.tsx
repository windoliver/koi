/**
 * Slash command completion overlay — renders a filtered list of matching
 * commands when the user types "/" at the start of input.
 *
 * Keyboard navigation and scroll state are handled via createScrollableList
 * and handleSelectOverlayKey (shared with SelectOverlay).
 *
 * Positioning is the parent's responsibility (ConversationView wraps this in
 * an absolutely-positioned box so it floats above the InputArea).
 */

import type { KeyEvent } from "@opentui/core";
import { useKeyboard } from "@opentui/solid";
import type { JSX } from "solid-js";
import { createMemo, For, Show } from "solid-js";
import { matchCommands, type SlashCommand, type SlashMatch } from "../commands/slash-detection.js";
import { COLORS } from "../theme.js";
import { createScrollableList, handleSelectOverlayKey } from "./select-overlay-helpers.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_VISIBLE = 8;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SlashOverlayProps {
  /** Current query text (after the "/"). */
  readonly query: string;
  /** Available slash commands. */
  readonly commands: readonly SlashCommand[];
  /** Called when the user selects a command. */
  readonly onSelect: (command: SlashCommand) => void;
  /** Called when the user presses Escape to dismiss. */
  readonly onDismiss: () => void;
  /** Whether this overlay has keyboard focus. */
  readonly focused: boolean;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function SlashOverlay(props: SlashOverlayProps): JSX.Element {
  // Strip everything from the first space onward before matching — the
  // query may include command arguments (e.g. "rewind 1"), and
  // matchCommands does prefix match on the command name only. Without
  // this, typing "/rewind 1 <Enter>" fires the overlay's onSelect with
  // zero matches and silently dispatches nothing.
  const matchQuery = createMemo<string>(() => {
    const q = props.query;
    const spaceIdx = q.indexOf(" ");
    return spaceIdx === -1 ? q : q.slice(0, spaceIdx);
  });
  const matches = createMemo<readonly SlashMatch[]>(() =>
    matchCommands(props.commands, matchQuery()),
  );

  const list = createScrollableList(matches, MAX_VISIBLE);

  useKeyboard((key: KeyEvent) => {
    if (!props.focused) return;
    handleSelectOverlayKey(key, {
      onClose: props.onDismiss,
      onSelect: (): void => {
        const match = matches()[list.selectedIdx()];
        if (match !== undefined) props.onSelect(match.command);
      },
      onMoveUp: list.moveUp,
      onMoveDown: list.moveDown,
    });
  });

  return (
    <Show
      when={matches().length > 0}
      fallback={
        <box border={true} borderColor={COLORS.textMuted} paddingLeft={1}>
          <text fg={COLORS.textMuted}>{"No matching commands"}</text>
        </box>
      }
    >
      <box
        flexDirection="column"
        border={true}
        borderColor={COLORS.blueAccent}
        width={50}
      >
        <box paddingLeft={1}>
          <text fg={COLORS.blueAccent}><b>{"Commands"}</b></text>
        </box>
        <For each={list.visibleItems()}>
          {(m, localIdx) => {
            const isSelected = (): boolean =>
              list.visibleStart() + localIdx() === list.selectedIdx();
            return (
              <box paddingLeft={2}>
                <text fg={isSelected() ? COLORS.yellow : COLORS.white}>
                  {(isSelected() ? "▶ /" : "  /") + m.command.name}
                </text>
                <text fg={isSelected() ? COLORS.textSecondary : COLORS.textMuted}>
                  {"   " + m.command.description}
                </text>
              </box>
            );
          }}
        </For>
      </box>
    </Show>
  );
}
