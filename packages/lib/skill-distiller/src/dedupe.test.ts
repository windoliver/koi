import { describe, expect, test } from "bun:test";
import { createDedupeIndex } from "./dedupe.js";
import type { DistillationRecord } from "./types.js";

const recordWith = (draftHash: string): DistillationRecord => ({
  draft: {
    name: "x",
    description: "x",
    triggers: [],
    parameters: [],
    toolSequence: [],
    expectedInputs: [],
    expectedOutputs: [],
  },
  source: { traceId: "t", timestamp: 0, sourceHash: "src" },
  draftHash,
});

describe("createDedupeIndex", () => {
  test("first register returns 'new', second with same hash returns 'duplicate'", () => {
    const idx = createDedupeIndex();
    expect(idx.register(recordWith("h1"))).toBe("new");
    expect(idx.register(recordWith("h1"))).toBe("duplicate");
  });

  test("different hashes count separately", () => {
    const idx = createDedupeIndex();
    idx.register(recordWith("h1"));
    idx.register(recordWith("h2"));
    expect(idx.size()).toBe(2);
  });

  test("has() reflects registration", () => {
    const idx = createDedupeIndex();
    expect(idx.has("h1")).toBe(false);
    idx.register(recordWith("h1"));
    expect(idx.has("h1")).toBe(true);
  });

  test("clear() resets state", () => {
    const idx = createDedupeIndex();
    idx.register(recordWith("h1"));
    idx.clear();
    expect(idx.size()).toBe(0);
    expect(idx.has("h1")).toBe(false);
  });
});
