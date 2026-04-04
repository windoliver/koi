/**
 * SelectOverlay<T> — generic keyboard-navigable list selector.
 *
 * Pure renderer: takes items + callbacks, emits selection or close.
 * No search input, no filtering — those live in the parent.
 * Used by both CommandPalette and SessionPicker.
 */

import type { KeyEvent } from "@opentui/core";
import { useKeyboard } from "@opentui/solid";
import type { JSX } from "solid-js";
import { createMemo, Show } from "solid-js";
import { handleSelectOverlayKey } from "./select-overlay-helpers.js";

export { handleSelectOverlayKey };

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SelectOverlayProps<T> {
  /** Items to display. Empty array shows emptyText. */
  readonly items: readonly T[];
  /** Extract the primary label for each item. */
  readonly getLabel: (item: T) => string;
  /** Optional secondary description shown next to the label. */
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
  // Map items → OpenTUI <select> option shape using array index as value key
  const options = createMemo(() =>
    props.items.map((item, i) => ({
      name: props.getLabel(item),
      // SelectOption requires description: string — use "" when no descriptor provided
      description: props.getDescription ? props.getDescription(item) : "",
      value: String(i),
    })),
  );

  const handleSelect = (_index: number, option: { readonly value?: string } | null): void => {
    if (option === null || option.value === undefined) return;
    const idx = Number(option.value);
    const item = props.items[idx];
    if (item !== undefined) props.onSelect(item);
  };

  useKeyboard((key: KeyEvent) => {
    if (!props.focused) return;
    if (key.name === "escape") {
      key.preventDefault();
      props.onClose();
    }
  });

  return (
    <Show
      when={props.items.length > 0}
      fallback={
        <box paddingLeft={1}>
          <text fg="#64748B">{props.emptyText ?? "No items"}</text>
        </box>
      }
    >
      <select
        options={options()}
        focused={props.focused}
        showDescription={props.getDescription !== undefined}
        wrapSelection={true}
        onSelect={handleSelect}
      />
    </Show>
  );
}
