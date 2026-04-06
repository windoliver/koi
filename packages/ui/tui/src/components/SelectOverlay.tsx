/**
 * SelectOverlay<T> — generic keyboard-navigable list selector.
 *
 * Pure renderer: takes items + callbacks, emits selection or close.
 * No search input, no filtering — those live in the parent.
 * Used by both CommandPalette and SessionPicker.
 *
 * Uses a <For> loop (not OpenTUI <select>) for reliable rendering without
 * frameBuffer height management. Scroll state is managed by createScrollableList.
 */

import type { KeyEvent } from "@opentui/core";
import { useKeyboard } from "@opentui/solid";
import type { JSX } from "solid-js";
import { For, Show } from "solid-js";
import { COLORS } from "../theme.js";
import { createScrollableList, handleSelectOverlayKey } from "./select-overlay-helpers.js";

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
  const list = createScrollableList(() => props.items, MAX_VISIBLE);

  useKeyboard((key: KeyEvent) => {
    if (!props.focused) return;
    handleSelectOverlayKey(key, {
      onClose: props.onClose,
      onSelect: (): void => {
        const item = props.items[list.selectedIdx()];
        if (item !== undefined) props.onSelect(item);
      },
      onMoveUp: list.moveUp,
      onMoveDown: list.moveDown,
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
      <For each={list.visibleItems()}>
        {(item, localIdx) => {
          const isSelected = (): boolean =>
            list.visibleStart() + localIdx() === list.selectedIdx();
          const description = (): string | undefined => props.getDescription?.(item);
          return (
            <box paddingLeft={1}>
              <text fg={isSelected() ? COLORS.yellow : COLORS.white}>
                {(isSelected() ? "▶ " : "  ") + props.getLabel(item)}
              </text>
              <Show when={description()}>
                {(d: () => string) => (
                  <text fg={isSelected() ? COLORS.textSecondary : COLORS.textMuted}>
                    {"  " + d()}
                  </text>
                )}
              </Show>
            </box>
          );
        }}
      </For>
    </Show>
  );
}
