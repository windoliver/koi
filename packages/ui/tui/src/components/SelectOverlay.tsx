/**
 * SelectOverlay<T> — generic keyboard-navigable list selector.
 *
 * Pure renderer: takes items + callbacks, emits selection or close.
 * No search input, no filtering — those live in the parent.
 * Used by both CommandPalette and SessionPicker.
 *
 * Uses a <For> loop (not OpenTUI <select>) for reliable rendering without
 * frameBuffer height management. Keyboard navigation is handled manually.
 */

import type { KeyEvent } from "@opentui/core";
import { useKeyboard } from "@opentui/solid";
import type { JSX } from "solid-js";
import { createEffect, createMemo, createSignal, For, Show } from "solid-js";
import { COLORS } from "../theme.js";
import { handleSelectOverlayKey } from "./select-overlay-helpers.js";

export { handleSelectOverlayKey };

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_VISIBLE = 8;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SelectOverlayProps<T> {
  /** Items to display. Empty array shows emptyText. */
  readonly items: readonly T[];
  /** Extract the primary label for each item. */
  readonly getLabel: (item: T) => string;
  /** Optional secondary description shown below the label. */
  readonly getDescription?: ((item: T) => string) | undefined;
  /** Called when the user selects an item (Enter). */
  readonly onSelect: (item: T) => void;
  /** Called when the user dismisses (Escape). */
  readonly onClose: () => void;
  /** Whether this overlay currently has keyboard focus. */
  readonly focused: boolean;
  /** Shown when items is empty. */
  readonly emptyText?: string | undefined;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function SelectOverlay<T>(props: SelectOverlayProps<T>): JSX.Element {
  const [selectedIdx, setSelectedIdx] = createSignal(0);

  // Clamp selection to valid range when items change
  createEffect((): void => {
    const count = props.items.length;
    setSelectedIdx((prev) => (count === 0 ? 0 : Math.min(prev, count - 1)));
  });

  const visibleStart = createMemo((): number => {
    const idx = selectedIdx();
    const count = props.items.length;
    if (count <= MAX_VISIBLE) return 0;
    return Math.max(0, Math.min(idx - Math.floor(MAX_VISIBLE / 2), count - MAX_VISIBLE));
  });

  const visibleItems = createMemo((): readonly T[] =>
    props.items.slice(visibleStart(), visibleStart() + MAX_VISIBLE),
  );

  useKeyboard((key: KeyEvent) => {
    if (!props.focused) return;
    handleSelectOverlayKey(key, {
      onClose: props.onClose,
      onSelect: (): void => {
        const item = props.items[selectedIdx()];
        if (item !== undefined) props.onSelect(item);
      },
      onMoveUp: (): void => {
        setSelectedIdx((i) => Math.max(i - 1, 0));
      },
      onMoveDown: (): void => {
        setSelectedIdx((i) => Math.min(i + 1, props.items.length - 1));
      },
    });
  });

  return (
    <Show
      when={props.items.length > 0}
      fallback={
        <box paddingLeft={1}>
          <text fg={COLORS.textMuted}>{props.emptyText ?? "No items"}</text>
        </box>
      }
    >
      <For each={visibleItems()}>
        {(item, localIdx) => {
          const isSelected = (): boolean => visibleStart() + localIdx() === selectedIdx();
          return (
            <box paddingLeft={1}>
              <text fg={isSelected() ? COLORS.yellow : COLORS.white}>
                {(isSelected() ? "▶ " : "  ") + props.getLabel(item)}
              </text>
              <Show when={props.getDescription !== undefined}>
                <text fg={isSelected() ? COLORS.textSecondary : COLORS.textMuted}>
                  {"  " + props.getDescription!(item)}
                </text>
              </Show>
            </box>
          );
        }}
      </For>
    </Show>
  );
}
