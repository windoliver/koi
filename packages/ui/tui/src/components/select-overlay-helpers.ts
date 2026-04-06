/**
 * Pure key-handler helper for SelectOverlay — exported as a plain .ts file so
 * tests can import it without triggering the JSX runtime.
 *
 * Also exports `createScrollableList` — a reusable SolidJS primitive for
 * keyboard-navigable lists with a centered scrolling window.
 */

import type { KeyEvent } from "@opentui/core";
import type { Accessor } from "solid-js";
import { createMemo, createSignal } from "solid-js";

// ---------------------------------------------------------------------------
// Keyboard handler
// ---------------------------------------------------------------------------

/** Process a key for any select overlay. Returns true if consumed. */
export function handleSelectOverlayKey(
  key: KeyEvent,
  callbacks: {
    readonly onClose: () => void;
    readonly onSelect?: (() => void) | undefined;
    readonly onMoveUp?: (() => void) | undefined;
    readonly onMoveDown?: (() => void) | undefined;
  },
): boolean {
  if (key.name === "escape") {
    callbacks.onClose();
    return true;
  }
  if (key.name === "return" || key.name === "tab") {
    callbacks.onSelect?.();
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
// Scrollable list primitive
// ---------------------------------------------------------------------------

/**
 * Compute the start index of the visible window so it stays centered on the
 * selected item. Exported as a pure function for unit testing.
 */
export function computeVisibleStart(idx: number, count: number, pageSize: number): number {
  if (count <= pageSize) return 0;
  return Math.max(0, Math.min(idx - Math.floor(pageSize / 2), count - pageSize));
}

/** State returned by `createScrollableList`. */
export interface ScrollableList<T> {
  readonly selectedIdx: Accessor<number>;
  readonly visibleItems: Accessor<readonly T[]>;
  readonly visibleStart: Accessor<number>;
  readonly moveUp: () => void;
  readonly moveDown: () => void;
}

/**
 * SolidJS primitive: keyboard-navigable list with a centered scrolling window.
 *
 * @param items  Reactive accessor for the full item list.
 * @param pageSize  Maximum visible rows (scroll window size).
 *
 * Usage:
 * ```tsx
 * const list = createScrollableList(() => props.items, 8);
 * <For each={list.visibleItems()}>
 *   {(item, localIdx) => {
 *     const isSelected = () => list.visibleStart() + localIdx() === list.selectedIdx();
 *     ...
 *   }}
 * </For>
 * ```
 */
export function createScrollableList<T>(
  items: Accessor<readonly T[]>,
  pageSize: number,
): ScrollableList<T> {
  const [rawIdx, setRawIdx] = createSignal(0);

  // Clamp selection synchronously via memo — avoids deferred createEffect flush.
  const selectedIdx = createMemo((): number => {
    const count = items().length;
    return count === 0 ? 0 : Math.min(rawIdx(), count - 1);
  });

  const visibleStart = createMemo((): number =>
    computeVisibleStart(selectedIdx(), items().length, pageSize),
  );

  const visibleItems = createMemo((): readonly T[] =>
    items().slice(visibleStart(), visibleStart() + pageSize),
  );

  return {
    selectedIdx,
    visibleItems,
    visibleStart,
    moveUp: () => setRawIdx((i) => Math.max(i - 1, 0)),
    moveDown: () =>
      setRawIdx((i) => {
        const max = items().length - 1;
        return max < 0 ? 0 : Math.min(i + 1, max);
      }),
  };
}
