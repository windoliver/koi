/**
 * SelectOverlay<T> — generic keyboard-navigable list selector.
 *
 * Pure renderer: takes items + callbacks, emits selection or close.
 * No search input, no filtering — those live in the parent.
 * Used by both CommandPalette and SessionPicker.
 */

import type { KeyEvent } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import React, { memo, useCallback, useMemo } from "react";
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
// Component (not memo — generic components cannot use memo directly)
// ---------------------------------------------------------------------------

export function SelectOverlay<T>(props: SelectOverlayProps<T>): React.ReactNode {
  const { items, getLabel, getDescription, onSelect, onClose, focused, emptyText = "No items" } =
    props;

  // Map items → OpenTUI <select> option shape using array index as value key
  const options = useMemo(
    () =>
      items.map((item, i) => ({
        name: getLabel(item),
        // SelectOption requires description: string — use "" when no descriptor provided
        description: getDescription ? getDescription(item) : "",
        value: String(i),
      })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [items, getLabel, getDescription],
  );

  const handleSelect = useCallback(
    (_index: number, option: { readonly value?: string } | null) => {
      if (option === null || option.value === undefined) return;
      const idx = Number(option.value);
      const item = items[idx];
      if (item !== undefined) onSelect(item);
    },
    [items, onSelect],
  );

  useKeyboard(
    useCallback(
      (key: KeyEvent) => {
        if (!focused) return;
        if (key.name === "escape") {
          key.preventDefault();
          onClose();
        }
      },
      [focused, onClose],
    ),
  );

  if (items.length === 0) {
    return (
      <box paddingLeft={1}>
        <text fg="#64748B">{emptyText}</text>
      </box>
    );
  }

  return (
    <select
      options={options}
      focused={focused}
      showDescription={getDescription !== undefined}
      wrapSelection={true}
      onSelect={handleSelect}
    />
  );
}
