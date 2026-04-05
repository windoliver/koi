/**
 * Slash command completion overlay — renders a filtered list of matching
 * commands when the user types "/" at the start of input.
 *
 * Uses a <For> loop (not OpenTUI <select>) so items render reliably without
 * requiring explicit frameBuffer height management. Keyboard navigation is
 * handled manually via useKeyboard.
 */

import type { KeyEvent } from "@opentui/core";
import { useKeyboard } from "@opentui/solid";
import type { JSX } from "solid-js";
import { createEffect, createMemo, createSignal, For, Show } from "solid-js";
import { matchCommands, type SlashCommand, type SlashMatch } from "../commands/slash-detection.js";
import { COLORS } from "../theme.js";

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
// Key handling (pure, exported for testing)
// ---------------------------------------------------------------------------

/**
 * Pure key handler for testing. Handles Escape (dismiss), Enter/Tab (select),
 * and Up/Down / Ctrl+P/N (navigate). Returns true if consumed.
 */
export function handleSlashOverlayKey(
  key: KeyEvent,
  callbacks: {
    readonly onSelect: () => void;
    readonly onDismiss: () => void;
    readonly onMoveUp?: (() => void) | undefined;
    readonly onMoveDown?: (() => void) | undefined;
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
  if (key.name === "up" || (key.ctrl && key.name === "p")) {
    callbacks.onMoveUp?.();
    return true;
  }
  if (key.name === "down" || (key.ctrl && key.name === "n")) {
    callbacks.onMoveDown?.();
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function SlashOverlay(props: SlashOverlayProps): JSX.Element {
  const matches = createMemo<readonly SlashMatch[]>(() =>
    matchCommands(props.commands, props.query),
  );

  const [selectedIdx, setSelectedIdx] = createSignal(0);

  // Clamp selection to valid range when the match list changes
  createEffect((): void => {
    const count = matches().length;
    setSelectedIdx((prev) => (count === 0 ? 0 : Math.min(prev, count - 1)));
  });

  const visibleStart = createMemo((): number => {
    const idx = selectedIdx();
    const count = matches().length;
    if (count <= MAX_VISIBLE) return 0;
    return Math.max(0, Math.min(idx - Math.floor(MAX_VISIBLE / 2), count - MAX_VISIBLE));
  });

  const visibleItems = createMemo((): readonly SlashMatch[] =>
    matches().slice(visibleStart(), visibleStart() + MAX_VISIBLE),
  );

  useKeyboard((key: KeyEvent) => {
    if (!props.focused) return;
    handleSlashOverlayKey(key, {
      onSelect: (): void => {
        const match = matches()[selectedIdx()];
        if (match !== undefined) props.onSelect(match.command);
      },
      onDismiss: props.onDismiss,
      onMoveUp: (): void => {
        setSelectedIdx((i) => Math.max(i - 1, 0));
      },
      onMoveDown: (): void => {
        setSelectedIdx((i) => Math.min(i + 1, matches().length - 1));
      },
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
        <For each={visibleItems()}>
          {(m, localIdx) => {
            const isSelected = (): boolean => visibleStart() + localIdx() === selectedIdx();
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
