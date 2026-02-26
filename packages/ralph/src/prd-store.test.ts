import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { markDone, markSkipped, nextItem, readPRD } from "./prd-store.js";
import type { PRDFile, PRDItem } from "./types.js";

const SAMPLE_PRD: PRDFile = {
  items: [
    { id: "a", description: "First task", done: false },
    { id: "b", description: "Second task", done: true, verifiedAt: "2024-01-01T00:00:00.000Z" },
    { id: "c", description: "Third task", done: false },
  ],
};

let tmpDir: string;
let prdPath: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "ralph-prd-"));
  prdPath = join(tmpDir, "prd.json");
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe("readPRD", () => {
  test("reads valid PRD file", async () => {
    await Bun.write(prdPath, JSON.stringify(SAMPLE_PRD, null, 2));
    const result = await readPRD(prdPath);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.items).toHaveLength(3);
      expect(result.value.items[0]?.id).toBe("a");
    }
  });

  test("returns NOT_FOUND for missing file", async () => {
    const result = await readPRD(join(tmpDir, "nonexistent.json"));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("NOT_FOUND");
    }
  });

  test("returns VALIDATION for malformed JSON", async () => {
    await Bun.write(prdPath, "{ not valid json }}}");
    const result = await readPRD(prdPath);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
    }
  });

  test("returns VALIDATION for missing items array", async () => {
    await Bun.write(prdPath, JSON.stringify({ name: "no items" }));
    const result = await readPRD(prdPath);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
    }
  });
});

describe("nextItem", () => {
  test("returns first undone item", () => {
    const result = nextItem(SAMPLE_PRD.items);
    expect(result?.id).toBe("a");
  });

  test("skips done items", () => {
    const items: readonly PRDItem[] = [
      { id: "a", description: "Done", done: true },
      { id: "b", description: "Not done", done: false },
    ];
    expect(nextItem(items)?.id).toBe("b");
  });

  test("returns undefined when all done", () => {
    const items: readonly PRDItem[] = [{ id: "a", description: "Done", done: true }];
    expect(nextItem(items)).toBeUndefined();
  });

  test("returns undefined for empty array", () => {
    expect(nextItem([])).toBeUndefined();
  });

  test("skips items marked as skipped", () => {
    const items: readonly PRDItem[] = [
      { id: "a", description: "Skipped", done: false, skipped: true },
      { id: "b", description: "Available", done: false },
    ];
    expect(nextItem(items)?.id).toBe("b");
  });

  test("returns undefined when all items are done or skipped", () => {
    const items: readonly PRDItem[] = [
      { id: "a", description: "Done", done: true },
      { id: "b", description: "Skipped", done: false, skipped: true },
    ];
    expect(nextItem(items)).toBeUndefined();
  });

  test("respects priority ordering (lower = higher priority)", () => {
    const items: readonly PRDItem[] = [
      { id: "a", description: "Low priority", done: false, priority: 10 },
      { id: "b", description: "High priority", done: false, priority: 1 },
      { id: "c", description: "Medium priority", done: false, priority: 5 },
    ];
    expect(nextItem(items)?.id).toBe("b");
  });

  test("treats missing priority as 0", () => {
    const items: readonly PRDItem[] = [
      { id: "a", description: "Explicit low", done: false, priority: 5 },
      { id: "b", description: "Default priority", done: false },
    ];
    expect(nextItem(items)?.id).toBe("b");
  });

  test("preserves document order for equal priority", () => {
    const items: readonly PRDItem[] = [
      { id: "a", description: "First", done: false, priority: 1 },
      { id: "b", description: "Second", done: false, priority: 1 },
    ];
    expect(nextItem(items)?.id).toBe("a");
  });
});

describe("markSkipped", () => {
  test("marks item as skipped", async () => {
    await Bun.write(prdPath, JSON.stringify(SAMPLE_PRD, null, 2));

    const result = await markSkipped(prdPath, "a");
    expect(result.ok).toBe(true);

    const updated = await readPRD(prdPath);
    expect(updated.ok).toBe(true);
    if (updated.ok) {
      const item = updated.value.items.find((i) => i.id === "a");
      expect(item?.skipped).toBe(true);
      expect(item?.done).toBe(false); // skipped, not done
    }
  });

  test("returns NOT_FOUND for unknown item", async () => {
    await Bun.write(prdPath, JSON.stringify(SAMPLE_PRD, null, 2));
    const result = await markSkipped(prdPath, "nonexistent");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("NOT_FOUND");
    }
  });

  test("preserves other items unchanged", async () => {
    await Bun.write(prdPath, JSON.stringify(SAMPLE_PRD, null, 2));
    await markSkipped(prdPath, "a");

    const updated = await readPRD(prdPath);
    if (updated.ok) {
      const itemC = updated.value.items.find((i) => i.id === "c");
      expect(itemC?.done).toBe(false);
      expect(itemC?.skipped).toBeUndefined();
    }
  });
});

describe("markDone", () => {
  test("updates item and writes atomically", async () => {
    await Bun.write(prdPath, JSON.stringify(SAMPLE_PRD, null, 2));

    const result = await markDone(prdPath, "a");
    expect(result.ok).toBe(true);

    // Verify file was updated
    const updated = await readPRD(prdPath);
    expect(updated.ok).toBe(true);
    if (updated.ok) {
      const item = updated.value.items.find((i) => i.id === "a");
      expect(item?.done).toBe(true);
      expect(item?.verifiedAt).toBeDefined();
      expect(item?.iterationCount).toBe(1);
    }

    // Verify tmp file doesn't persist
    const tmpExists = await Bun.file(`${prdPath}.tmp`).exists();
    expect(tmpExists).toBe(false);
  });

  test("increments iterationCount on repeated markDone", async () => {
    const prd: PRDFile = {
      items: [{ id: "a", description: "Task", done: false, iterationCount: 2 }],
    };
    await Bun.write(prdPath, JSON.stringify(prd, null, 2));

    // markDone sets done=true, but we want to test iterationCount
    const result = await markDone(prdPath, "a");
    expect(result.ok).toBe(true);

    const updated = await readPRD(prdPath);
    if (updated.ok) {
      expect(updated.value.items[0]?.iterationCount).toBe(3);
    }
  });

  test("returns NOT_FOUND for unknown item", async () => {
    await Bun.write(prdPath, JSON.stringify(SAMPLE_PRD, null, 2));
    const result = await markDone(prdPath, "nonexistent");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("NOT_FOUND");
    }
  });

  test("returns NOT_FOUND for missing file", async () => {
    const result = await markDone(join(tmpDir, "missing.json"), "a");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("NOT_FOUND");
    }
  });

  test("preserves other items unchanged", async () => {
    await Bun.write(prdPath, JSON.stringify(SAMPLE_PRD, null, 2));
    await markDone(prdPath, "a");

    const updated = await readPRD(prdPath);
    if (updated.ok) {
      const itemB = updated.value.items.find((i) => i.id === "b");
      expect(itemB?.done).toBe(true);
      expect(itemB?.verifiedAt).toBe("2024-01-01T00:00:00.000Z");

      const itemC = updated.value.items.find((i) => i.id === "c");
      expect(itemC?.done).toBe(false);
    }
  });
});
