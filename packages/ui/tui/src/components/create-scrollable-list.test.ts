/**
 * Tests for computeVisibleStart and createScrollableList.
 *
 * computeVisibleStart is a pure function and tested directly.
 * createScrollableList is tested inside a Solid reactive root so signals work.
 */

import { describe, expect, test } from "bun:test";
import { createRoot, createSignal } from "solid-js";
import { computeVisibleStart, createScrollableList } from "./select-overlay-helpers.js";

// ---------------------------------------------------------------------------
// computeVisibleStart — pure centering formula
// ---------------------------------------------------------------------------

describe("computeVisibleStart", () => {
  test("returns 0 when count <= pageSize", () => {
    expect(computeVisibleStart(0, 3, 8)).toBe(0);
    expect(computeVisibleStart(2, 3, 8)).toBe(0);
    expect(computeVisibleStart(4, 8, 8)).toBe(0);
  });

  test("returns 0 when selection is near the start", () => {
    // idx=0, count=10, pageSize=4: max(0, min(0-2, 10-4)) = max(0,-2) = 0
    expect(computeVisibleStart(0, 10, 4)).toBe(0);
    // idx=1, count=10, pageSize=4: max(0, min(1-2, 6)) = max(0,-1) = 0
    expect(computeVisibleStart(1, 10, 4)).toBe(0);
  });

  test("centers the window on the selected item", () => {
    // idx=5, count=10, pageSize=4: max(0, min(5-2, 6)) = max(0, 3) = 3
    expect(computeVisibleStart(5, 10, 4)).toBe(3);
  });

  test("clamps at the end when selection is near the end", () => {
    // idx=9, count=10, pageSize=4: max(0, min(9-2, 6)) = max(0, 6) = 6
    expect(computeVisibleStart(9, 10, 4)).toBe(6);
    // idx=8, count=10, pageSize=4: max(0, min(8-2, 6)) = max(0, 6) = 6
    expect(computeVisibleStart(8, 10, 4)).toBe(6);
  });

  test("handles pageSize=1 (single visible item)", () => {
    // idx=5, count=10, pageSize=1: max(0, min(5-0, 9)) = 5
    expect(computeVisibleStart(5, 10, 1)).toBe(5);
  });

  test("handles odd pageSize centering", () => {
    // pageSize=3, floor(3/2)=1
    // idx=5, count=10, pageSize=3: max(0, min(5-1, 7)) = 4
    expect(computeVisibleStart(5, 10, 3)).toBe(4);
  });

  test("handles even pageSize centering", () => {
    // pageSize=4, floor(4/2)=2
    // idx=5, count=10, pageSize=4: max(0, min(5-2, 6)) = 3
    expect(computeVisibleStart(5, 10, 4)).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// createScrollableList — SolidJS reactive primitive
// ---------------------------------------------------------------------------

describe("createScrollableList", () => {
  test("visibleItems returns full list when count <= pageSize", () => {
    const result = createRoot((dispose) => {
      const items = ["a", "b", "c"] as const;
      const list = createScrollableList(() => items, 8);
      const r = {
        visibleItems: list.visibleItems(),
        selectedIdx: list.selectedIdx(),
        visibleStart: list.visibleStart(),
      };
      dispose();
      return r;
    });
    expect(result.visibleItems).toEqual(["a", "b", "c"]);
    expect(result.selectedIdx).toBe(0);
    expect(result.visibleStart).toBe(0);
  });

  test("visibleItems returns page-sized slice for large lists", () => {
    const result = createRoot((dispose) => {
      const items = Array.from({ length: 20 }, (_, i) => `item-${i}`);
      const list = createScrollableList(() => items, 4);
      const r = { visibleItems: list.visibleItems() };
      dispose();
      return r;
    });
    expect(result.visibleItems.length).toBe(4);
    expect(result.visibleItems[0]).toBe("item-0");
  });

  test("moveDown increments selectedIdx", () => {
    const result = createRoot((dispose) => {
      const items = ["a", "b", "c", "d", "e"];
      const list = createScrollableList(() => items, 8);
      list.moveDown();
      list.moveDown();
      const r = { selectedIdx: list.selectedIdx() };
      dispose();
      return r;
    });
    expect(result.selectedIdx).toBe(2);
  });

  test("moveUp decrements selectedIdx but clamps at 0", () => {
    const result = createRoot((dispose) => {
      const items = ["a", "b", "c"];
      const list = createScrollableList(() => items, 8);
      list.moveUp(); // already at 0 — should stay 0
      const r = { selectedIdx: list.selectedIdx() };
      dispose();
      return r;
    });
    expect(result.selectedIdx).toBe(0);
  });

  test("moveDown clamps at last item", () => {
    const result = createRoot((dispose) => {
      const items = ["a", "b", "c"];
      const list = createScrollableList(() => items, 8);
      list.moveDown();
      list.moveDown();
      list.moveDown(); // already at last — should stay at 2
      list.moveDown();
      const r = { selectedIdx: list.selectedIdx() };
      dispose();
      return r;
    });
    expect(result.selectedIdx).toBe(2);
  });

  test("selectedIdx clamps when items shrink", () => {
    const result = createRoot((dispose) => {
      const [items, setItems] = createSignal(["a", "b", "c", "d", "e"]);
      const list = createScrollableList(items, 8);
      // Navigate to idx=4
      list.moveDown();
      list.moveDown();
      list.moveDown();
      list.moveDown();
      expect(list.selectedIdx()).toBe(4);
      // Shrink list to 3 items — selectedIdx should clamp to 2
      setItems(["a", "b", "c"]);
      const r = { selectedIdx: list.selectedIdx() };
      dispose();
      return r;
    });
    expect(result.selectedIdx).toBe(2);
  });

  test("visibleStart shifts when selection scrolls off-screen", () => {
    const result = createRoot((dispose) => {
      const items = Array.from({ length: 10 }, (_, i) => `item-${i}`);
      const list = createScrollableList(() => items, 4);
      // Move to idx=7 (near end)
      for (let i = 0; i < 7; i++) list.moveDown();
      const r = {
        selectedIdx: list.selectedIdx(),
        visibleStart: list.visibleStart(),
        visibleItems: list.visibleItems(),
      };
      dispose();
      return r;
    });
    expect(result.selectedIdx).toBe(7);
    // visibleStart = computeVisibleStart(7, 10, 4) = max(0, min(7-2, 6)) = 5
    expect(result.visibleStart).toBe(5);
    expect(result.visibleItems[0]).toBe("item-5");
    expect(result.visibleItems.length).toBe(4);
  });
});
