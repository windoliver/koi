import { describe, expect, test } from "bun:test";
import { mapWithConcurrency } from "./map-with-concurrency.js";

describe("mapWithConcurrency", () => {
  test("processes items with correct concurrency limit", async () => {
    let active = 0;
    let maxActive = 0;

    const items = [1, 2, 3, 4, 5, 6] as const;
    const concurrency = 2;

    await mapWithConcurrency(
      items,
      async (_item, _index) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        // Yield to event loop so other workers can start if slots allow
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
        active -= 1;
      },
      concurrency,
    );

    expect(maxActive).toBe(concurrency);
  });

  test("preserves order", async () => {
    const items = [30, 10, 20] as const;

    const results = await mapWithConcurrency(
      items,
      async (item) => {
        // Delay proportional to item value — if order wasn't preserved,
        // faster items would land in wrong slots
        await new Promise<void>((resolve) => setTimeout(resolve, item));
        return item * 2;
      },
      3,
    );

    expect(results).toEqual([60, 20, 40]);
  });

  test("rejects if any item throws", async () => {
    const items = [1, 2, 3] as const;

    const promise = mapWithConcurrency(
      items,
      async (item) => {
        if (item === 2) {
          throw new Error("boom");
        }
        return item;
      },
      2,
    );

    await expect(promise).rejects.toThrow("boom");
  });

  test("handles empty array", async () => {
    const results = await mapWithConcurrency([], async (item: number) => item * 2, 5);

    expect(results).toEqual([]);
  });

  test("concurrency <= 0 throws", () => {
    expect(() => mapWithConcurrency([1], async (x) => x, 0)).toThrow(
      "concurrency must be > 0, got 0",
    );

    expect(() => mapWithConcurrency([1], async (x) => x, -1)).toThrow(
      "concurrency must be > 0, got -1",
    );
  });

  test("concurrency greater than items length works correctly", async () => {
    const items = [1, 2] as const;

    const results = await mapWithConcurrency(items, async (item) => item * 10, 100);

    expect(results).toEqual([10, 20]);
  });

  test("passes index to mapper function", async () => {
    const items = ["a", "b", "c"] as const;
    const indices: number[] = [];

    await mapWithConcurrency(
      items,
      async (_item, index) => {
        indices.push(index);
      },
      2,
    );

    // All indices should be captured, though order of execution may vary
    expect(indices.sort()).toEqual([0, 1, 2]);
  });
});
