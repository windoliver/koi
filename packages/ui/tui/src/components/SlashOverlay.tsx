/**
 * Slash command completion overlay — renders a filtered list of matching
 * commands when the user types "/" at the start of input.
 *
 * Uses OpenTUI <select> for the filtered dropdown with keyboard navigation.
 * Rendered inline above the input area by the parent layout.
 */

import type { KeyEvent } from "@opentui/core";
import { useKeyboard } from "@opentui/solid";
import type { JSX } from "solid-js";
import { createMemo, Show } from "solid-js";
import { matchCommands, type SlashCommand, type SlashMatch } from "../commands/slash-detection.js";
import { COLORS } from "../theme.js";

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
// Key handling (pure, exported for testing)
// ---------------------------------------------------------------------------

/**
 * Pure key handler for testing. In the live component, Enter/Tab are handled
 * natively by OpenTUI <select> via its onSelect callback; only Escape is
 * intercepted by useKeyboard. Returns true if consumed.
 */
export function handleSlashOverlayKey(
  key: KeyEvent,
  callbacks: {
    readonly onSelect: () => void;
    readonly onDismiss: () => void;
  },
): boolean {
  if (key.name === "escape") {
    callbacks.onDismiss();
    return true;
  }
  if (key.name === "return" || key.name === "tab") {
    callbacks.onSelect();
    return true;
  }
  // Ctrl+P/N for Emacs-style navigation (handled by <select> natively)
  return false;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function SlashOverlay(props: SlashOverlayProps): JSX.Element {
  const matches = createMemo<readonly SlashMatch[]>(() =>
    matchCommands(props.commands, props.query),
  );

  const selectOptions = createMemo(() =>
    matches().map((m) => ({
      name: `/${m.command.name}`,
      description: m.command.description,
      value: m.command.name,
    })),
  );

  const handleSelect = (_index: number, option: { readonly value?: string } | null): void => {
    if (option === null || option.value === undefined) return;
    const cmd = props.commands.find((c) => c.name === option.value);
    if (cmd !== undefined) {
      props.onSelect(cmd);
    }
  };

  // Wire keyboard: Escape dismisses overlay. Enter/Tab handled by <select> onSelect.
  useKeyboard((key: KeyEvent) => {
    if (!props.focused) return;
    if (key.name === "escape") {
      key.preventDefault();
      props.onDismiss();
    }
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
        <select
          options={selectOptions()}
          focused={props.focused}
          showDescription={true}
          wrapSelection={true}
          onSelect={handleSelect}
        />
      </box>
    </Show>
  );
}
