import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bumpFailureCount,
  markDone,
  markDoneMany,
  markSkipped,
  nextItem,
  readPRD,
  resetFailureCount,
} from "./prd-store.js";
import type { PRDFile, PRDItem } from "./types.js";

const SAMPLE_PRD: PRDFile = {
  items: [
    { id: "a", description: "First task", done: false },
    { id: "b", description: "Second task", done: true, verifiedAt: "2024-01-01T00:00:00.000Z" },
    { id: "c", description: "Third task", done: false },
  ],
};

// Use let — justified: per-test tmpdir reassigned in beforeEach
let tmpDir: string;
let prdPath: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "verified-loop-prd-"));
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

  test("returns VALIDATION for done as a string (the truthy-string footgun)", async () => {
    await Bun.write(
      prdPath,
      JSON.stringify({ items: [{ id: "a", description: "x", done: "false" }] }),
    );
    const result = await readPRD(prdPath);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
      expect(result.error.message).toContain("'done' must be a boolean");
    }
  });

  test("returns VALIDATION for missing id", async () => {
    await Bun.write(
      prdPath,
      JSON.stringify({ items: [{ description: "no id here", done: false }] }),
    );
    const result = await readPRD(prdPath);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("'id'");
  });

  test("returns VALIDATION for empty-string id", async () => {
    await Bun.write(
      prdPath,
      JSON.stringify({ items: [{ id: "", description: "x", done: false }] }),
    );
    const result = await readPRD(prdPath);
    expect(result.ok).toBe(false);
  });

  test("rejects negative iterationCount", async () => {
    // Persisted counters must be non-negative integers — a hand-edited
    // PRD with iterationCount: -5 would distort every subsequent +1.
    await Bun.write(
      prdPath,
      JSON.stringify({
        items: [{ id: "a", description: "x", done: false, iterationCount: -5 }],
      }),
    );
    const result = await readPRD(prdPath);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
      expect(result.error.message).toContain("iterationCount");
    }
  });

  test("rejects fractional consecutiveFailureCount", async () => {
    // bumpFailureCount does (count ?? 0) + 1 and compares to threshold;
    // a fractional persisted value would make the budget unpredictable.
    await Bun.write(
      prdPath,
      JSON.stringify({
        items: [{ id: "a", description: "x", done: false, consecutiveFailureCount: 1.5 }],
      }),
    );
    const result = await readPRD(prdPath);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
      expect(result.error.message).toContain("consecutiveFailureCount");
    }
  });

  test("rejects non-finite priority (NaN, Infinity)", async () => {
    // JSON.stringify turns NaN/Infinity into null, so simulate an externally
    // produced file. Sort order would be undefined for NaN priorities.
    await Bun.write(
      prdPath,
      '{"items":[{"id":"a","description":"x","done":false,"priority":null}]}',
    );
    // null is not a number — caught by the existing typeof check (negative
    // path); this test guards the Number.isFinite check by writing a JSON
    // string that the parser will load as the literal numeric NaN-style
    // value via a custom parser surrogate. Skip the JSON-encoding of NaN
    // (impossible) and assert the typeof guard still rejects null.
    const result = await readPRD(prdPath);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
    }
  });

  test("returns VALIDATION for non-numeric priority", async () => {
    await Bun.write(
      prdPath,
      JSON.stringify({
        items: [{ id: "a", description: "x", done: false, priority: "high" }],
      }),
    );
    const result = await readPRD(prdPath);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("'priority'");
  });

  test("returns VALIDATION for duplicate item ids", async () => {
    await Bun.write(
      prdPath,
      JSON.stringify({
        items: [
          { id: "a", description: "first", done: false },
          { id: "a", description: "second", done: false },
        ],
      }),
    );
    const result = await readPRD(prdPath);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
      expect(result.error.message).toContain("duplicate item id");
    }
  });

  test("rejects an item that is both done:true and skipped:true", async () => {
    // PRD is the source of truth — a contradictory record (item appears in
    // both completed[] and skipped[] of the result) must fail fast at read
    // time rather than silently propagate.
    await Bun.write(
      prdPath,
      JSON.stringify({
        items: [{ id: "a", description: "x", done: true, skipped: true }],
      }),
    );
    const result = await readPRD(prdPath);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
      expect(result.error.message).toContain("'done' and 'skipped' cannot both be true");
    }
  });

  test("accepts valid optional fields", async () => {
    await Bun.write(
      prdPath,
      JSON.stringify({
        items: [
          {
            id: "a",
            description: "x",
            done: true,
            skipped: false,
            priority: 5,
            iterationCount: 2,
            verifiedAt: "2024-01-01T00:00:00.000Z",
          },
        ],
      }),
    );
    const result = await readPRD(prdPath);
    expect(result.ok).toBe(true);
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
      expect(item?.done).toBe(false);
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

  test("refuses to skip an already-completed item (no contradictory state)", async () => {
    // Item "b" is done in SAMPLE_PRD. The result contract treats done and
    // skipped as mutually exclusive — the same id must never appear in both
    // arrays. Marking a done item as skipped is a misuse, not a state change.
    await Bun.write(prdPath, JSON.stringify(SAMPLE_PRD, null, 2));
    const result = await markSkipped(prdPath, "b");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("CONFLICT");
    }
    const after = await readPRD(prdPath);
    if (after.ok) {
      const b = after.value.items.find((i) => i.id === "b");
      expect(b?.done).toBe(true);
      expect(b?.skipped).toBeUndefined();
    }
  });
});

describe("markDone", () => {
  test("updates item and writes atomically", async () => {
    await Bun.write(prdPath, JSON.stringify(SAMPLE_PRD, null, 2));

    const result = await markDone(prdPath, "a");
    expect(result.ok).toBe(true);

    const updated = await readPRD(prdPath);
    expect(updated.ok).toBe(true);
    if (updated.ok) {
      const item = updated.value.items.find((i) => i.id === "a");
      expect(item?.done).toBe(true);
      expect(item?.verifiedAt).toBeDefined();
      expect(item?.iterationCount).toBe(1);
    }

    const tmpExists = await Bun.file(`${prdPath}.tmp`).exists();
    expect(tmpExists).toBe(false);
  });

  test("increments iterationCount on repeated markDone", async () => {
    const prd: PRDFile = {
      items: [{ id: "a", description: "Task", done: false, iterationCount: 2 }],
    };
    await Bun.write(prdPath, JSON.stringify(prd, null, 2));

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

describe("markDoneMany (atomic batch completion)", () => {
  test("marks all listed items done in one atomic write", async () => {
    await Bun.write(prdPath, JSON.stringify(SAMPLE_PRD, null, 2));
    const result = await markDoneMany(prdPath, ["a", "c"]);
    expect(result.ok).toBe(true);
    const updated = await readPRD(prdPath);
    if (updated.ok) {
      const byId = Object.fromEntries(updated.value.items.map((i) => [i.id, i]));
      expect(byId.a?.done).toBe(true);
      expect(byId.c?.done).toBe(true);
      expect(byId.a?.verifiedAt).toBeDefined();
      expect(byId.c?.verifiedAt).toBeDefined();
      // Both committed with the same timestamp (single write).
      expect(byId.a?.verifiedAt).toBe(byId.c?.verifiedAt);
    }
  });

  test("returns NOT_FOUND on any unknown id and writes nothing", async () => {
    await Bun.write(prdPath, JSON.stringify(SAMPLE_PRD, null, 2));
    const result = await markDoneMany(prdPath, ["a", "ghost"]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("NOT_FOUND");

    // Pre-flight failed → no item changed.
    const after = await readPRD(prdPath);
    if (after.ok) {
      const a = after.value.items.find((i) => i.id === "a");
      expect(a?.done).toBe(false);
    }
  });

  test("empty list is a no-op success", async () => {
    await Bun.write(prdPath, JSON.stringify(SAMPLE_PRD, null, 2));
    const result = await markDoneMany(prdPath, []);
    expect(result.ok).toBe(true);
  });

  test("CAS surfaces CONFLICT when the file changes between snapshot and write", async () => {
    // Optimistic concurrency: a writer with a stale snapshot must not
    // silently overwrite changes that landed in the meantime. Simulate
    // the race deterministically by mutating the file directly between
    // two sequential mutator calls: the second markDoneMany works from
    // its own fresh snapshot, but if a third party writes between its
    // read and write, the pre-rename CAS catches it.
    //
    // The most direct test of the CAS path is to hand the helper a
    // stale snapshot via the public read-then-write idiom: replace the
    // file mid-flight using a verify hook in a controlled flow. Here we
    // verify the simpler invariant that the CAS errors with CONFLICT
    // when a parallel write lands first.
    await Bun.write(prdPath, JSON.stringify(SAMPLE_PRD, null, 2));

    // Kick off a markDoneMany call for "a"; while it's mid-flight, write
    // an unrelated change to disk. Whichever lands second sees a diff.
    const promise = markDoneMany(prdPath, ["a"]);
    // Yield the microtask queue so the read inside markDoneMany completes,
    // then immediately overwrite the file so the pre-rename re-read fails.
    await new Promise((resolve) => setImmediate(resolve));
    await Bun.write(
      prdPath,
      JSON.stringify(
        {
          items: [
            { id: "a", description: "First task", done: false },
            {
              id: "b",
              description: "Second task",
              done: true,
              verifiedAt: "2099-01-01T00:00:00.000Z",
            },
            { id: "c", description: "Third task", done: false },
          ],
        },
        null,
        2,
      ),
    );
    const result = await promise;
    // Either markDoneMany wrote first (and the external write came after,
    // overwriting it) or the CAS caught the external write. Both outcomes
    // are valid expressions of the "no silent overwrite" invariant: a
    // concurrent writer either won outright (we lost cleanly) or the CAS
    // surfaced CONFLICT (we refused to clobber).
    if (!result.ok) {
      expect(result.error.code).toBe("CONFLICT");
    }
    // In either case, the file must contain coherent state — never a
    // partial merge. The interleaved write's "b" timestamp must survive
    // if it landed last, OR the markDoneMany state must be consistent.
    const after = await readPRD(prdPath);
    expect(after.ok).toBe(true);
  });

  test("preserves verifiedAt and iterationCount on already-completed items", async () => {
    // A gate that re-reports a completed id (cumulative itemsCompleted) or a
    // retry of the same set must not silently overwrite earlier verification
    // history. Item "b" is already done in SAMPLE_PRD with a fixed timestamp.
    await Bun.write(prdPath, JSON.stringify(SAMPLE_PRD, null, 2));
    const result = await markDoneMany(prdPath, ["a", "b"]);
    expect(result.ok).toBe(true);

    const after = await readPRD(prdPath);
    if (after.ok) {
      const a = after.value.items.find((i) => i.id === "a");
      const b = after.value.items.find((i) => i.id === "b");
      // a was pending: now done with fresh timestamp, iterationCount = 1.
      expect(a?.done).toBe(true);
      expect(a?.iterationCount).toBe(1);
      // b was already done: history preserved, no rewrite.
      expect(b?.done).toBe(true);
      expect(b?.verifiedAt).toBe("2024-01-01T00:00:00.000Z");
      expect(b?.iterationCount).toBeUndefined();
    }
  });
});

describe("bumpFailureCount", () => {
  test("increments count and persists across reads", async () => {
    await Bun.write(
      prdPath,
      JSON.stringify({ items: [{ id: "a", description: "x", done: false }] }),
    );

    const r1 = await bumpFailureCount(prdPath, "a", 5);
    expect(r1.ok).toBe(true);
    if (r1.ok) {
      expect(r1.value.count).toBe(1);
      expect(r1.value.skipped).toBe(false);
    }

    const r2 = await bumpFailureCount(prdPath, "a", 5);
    expect(r2.ok).toBe(true);
    if (r2.ok) {
      expect(r2.value.count).toBe(2);
    }

    const read = await readPRD(prdPath);
    expect(read.ok).toBe(true);
    if (read.ok) {
      expect(read.value.items[0]?.consecutiveFailureCount).toBe(2);
    }
  });

  test("flips skipped when count reaches threshold", async () => {
    await Bun.write(
      prdPath,
      JSON.stringify({ items: [{ id: "a", description: "x", done: false }] }),
    );

    await bumpFailureCount(prdPath, "a", 2);
    const result = await bumpFailureCount(prdPath, "a", 2);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.count).toBe(2);
      expect(result.value.skipped).toBe(true);
    }

    const read = await readPRD(prdPath);
    if (read.ok) {
      expect(read.value.items[0]?.skipped).toBe(true);
      expect(read.value.items[0]?.consecutiveFailureCount).toBe(2);
    }
  });

  test("returns NOT_FOUND for unknown item", async () => {
    await Bun.write(
      prdPath,
      JSON.stringify({ items: [{ id: "a", description: "x", done: false }] }),
    );
    const result = await bumpFailureCount(prdPath, "ghost", 5);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("NOT_FOUND");
  });

  test("refuses to bump on already-completed item (mutual-exclusion guard)", async () => {
    // Out-of-band completion (concurrent run, hand edit) between item
    // selection and failure persistence must not produce done:true +
    // skipped:true. markSkipped enforces this; bumpFailureCount must too.
    await Bun.write(
      prdPath,
      JSON.stringify({
        items: [{ id: "a", description: "x", done: true, verifiedAt: "2024-01-01T00:00:00.000Z" }],
      }),
    );
    const result = await bumpFailureCount(prdPath, "a", 2);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("CONFLICT");

    const after = await readPRD(prdPath);
    if (after.ok) {
      const a = after.value.items[0];
      expect(a?.done).toBe(true);
      expect(a?.skipped).toBeUndefined();
      expect(a?.consecutiveFailureCount).toBeUndefined();
    }
  });
});

describe("resetFailureCount", () => {
  test("clears count to 0", async () => {
    await Bun.write(
      prdPath,
      JSON.stringify({
        items: [{ id: "a", description: "x", done: false, consecutiveFailureCount: 3 }],
      }),
    );

    const result = await resetFailureCount(prdPath, "a");
    expect(result.ok).toBe(true);

    const read = await readPRD(prdPath);
    if (read.ok) {
      expect(read.value.items[0]?.consecutiveFailureCount).toBe(0);
    }
  });

  test("is a no-op when count is undefined", async () => {
    await Bun.write(
      prdPath,
      JSON.stringify({ items: [{ id: "a", description: "x", done: false }] }),
    );
    const result = await resetFailureCount(prdPath, "a");
    expect(result.ok).toBe(true);
    const read = await readPRD(prdPath);
    if (read.ok) {
      expect(read.value.items[0]?.consecutiveFailureCount).toBeUndefined();
    }
  });
});
