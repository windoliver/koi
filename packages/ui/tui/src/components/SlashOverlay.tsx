/**
 * Slash command completion overlay — renders a filtered list of matching
 * commands when the user types "/" at the start of input.
 *
 * Uses OpenTUI <select> for the filtered dropdown with keyboard navigation.
 * Absolute-positioned overlay (zIndex: 10) so it floats above content.
 */

import type { KeyEvent } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import React, { memo, useCallback, useMemo } from "react";
import { matchCommands, type SlashCommand, type SlashMatch } from "../commands/slash-detection.js";

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

/** Process a key for the slash overlay. Returns true if consumed. */
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

export const SlashOverlay: React.NamedExoticComponent<SlashOverlayProps> = memo(function SlashOverlay(
  props: SlashOverlayProps,
): React.ReactNode {
  const { query, commands, onSelect, onDismiss, focused } = props;

  const matches: readonly SlashMatch[] = useMemo(
    () => matchCommands(commands, query),
    [commands, query],
  );

  const selectOptions = useMemo(
    () =>
      matches.map((m) => ({
        name: `/${m.command.name}`,
        description: m.command.description,
        value: m.command.name,
      })),
    [matches],
  );

  const handleSelect = useCallback(
    (_index: number, option: { readonly value?: string } | null) => {
      if (option === null || option.value === undefined) return;
      const cmd = commands.find((c) => c.name === option.value);
      if (cmd !== undefined) {
        onSelect(cmd);
      }
    },
    [commands, onSelect],
  );

  // Wire keyboard: Escape dismisses overlay. Enter/Tab handled by <select> onSelect.
  useKeyboard(
    useCallback(
      (key: KeyEvent) => {
        if (!focused) return;
        if (key.name === "escape") {
          key.preventDefault();
          onDismiss();
        }
      },
      [focused, onDismiss],
    ),
  );

  if (matches.length === 0) {
    return (
      <box border={true} borderColor="#64748B" paddingLeft={1}>
        <text fg="#64748B">{"No matching commands"}</text>
      </box>
    );
  }

  return (
    <box
      flexDirection="column"
      border={true}
      borderColor="#60A5FA"
      width={50}
    >
      <box paddingLeft={1}>
        <text fg="#60A5FA"><b>{"Commands"}</b></text>
      </box>
      <select
        options={selectOptions}
        focused={focused}
        showDescription={true}
        wrapSelection={true}
        onSelect={handleSelect}
      />
    </box>
  );
});
