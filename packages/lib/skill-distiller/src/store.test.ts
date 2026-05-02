import { describe, expect, test } from "bun:test";
import type { SkillStoreReplacement } from "./store.js";
import { createSkillStore } from "./store.js";
import type { DistillationRecord } from "./types.js";

const rec = (name: string, draftHash = `hash-${name}`): DistillationRecord => ({
  draft: {
    name,
    description: name,
    triggers: [],
    parameters: [],
    toolSequence: [name],
    expectedInputs: [],
    expectedOutputs: [],
  },
  source: { traceId: name, timestamp: 0, sourceHash: `src-${name}` },
  draftHash,
});

describe("createSkillStore — basic semantics", () => {
  test("add returns 'added' for new name and 'duplicate' for same name+hash", () => {
    const s = createSkillStore();
    expect(s.add(rec("a"))).toBe("added");
    expect(s.add(rec("a"))).toBe("duplicate");
    expect(s.size()).toBe(1);
  });

  test("default conflict policy is 'reject': same-name + different-hash returns 'conflict' and preserves the existing record", () => {
    const s = createSkillStore();
    s.add(rec("a", "h1"));
    expect(s.add(rec("a", "h2"))).toBe("conflict");
    expect(s.size()).toBe(1);
    expect(s.get("a")?.draftHash).toBe("h1");
  });

  test("'replace' policy returns 'replaced' and fires onReplaced with prev+next", () => {
    const events: SkillStoreReplacement[] = [];
    const s = createSkillStore({ onConflict: "replace", onReplaced: (r) => events.push(r) });
    s.add(rec("a", "h1"));
    expect(s.add(rec("a", "h2"))).toBe("replaced");
    expect(s.size()).toBe(1);
    expect(s.get("a")?.draftHash).toBe("h2");
    expect(events.length).toBe(1);
    expect(events[0]?.previous.draftHash).toBe("h1");
    expect(events[0]?.next.draftHash).toBe("h2");
  });

  test("'keep' policy returns 'duplicate' and preserves the existing record", () => {
    const s = createSkillStore({ onConflict: "keep" });
    s.add(rec("a", "h1"));
    expect(s.add(rec("a", "h2"))).toBe("duplicate");
    expect(s.get("a")?.draftHash).toBe("h1");
  });

  test("replacement under 'replace' policy does not trigger LRU eviction", () => {
    const evicted: string[] = [];
    const s = createSkillStore({
      maxSize: 2,
      onConflict: "replace",
      onEvicted: (r) => evicted.push(r.draft.name),
    });
    s.add(rec("a", "h1"));
    s.add(rec("b", "hb"));
    expect(s.add(rec("a", "h2"))).toBe("replaced");
    expect(evicted).toEqual([]);
    expect(s.size()).toBe(2);
  });

  test("delete() removes an entry; subsequent same-name insert is 'added' not 'conflict'", () => {
    const s = createSkillStore();
    s.add(rec("a", "h1"));
    expect(s.delete("a")).toBe(true);
    expect(s.delete("a")).toBe(false);
    expect(s.add(rec("a", "h2"))).toBe("added");
  });

  test("has and hasHash reflect contents", () => {
    const s = createSkillStore();
    s.add(rec("a", "h1"));
    expect(s.has("a")).toBe(true);
    expect(s.hasHash("h1")).toBe(true);
    expect(s.has("b")).toBe(false);
    expect(s.hasHash("nope")).toBe(false);
  });

  test("clear empties the store", () => {
    const s = createSkillStore();
    s.add(rec("a"));
    s.add(rec("b"));
    s.clear();
    expect(s.size()).toBe(0);
  });
});

describe("createSkillStore — LRU eviction", () => {
  test("evicts oldest when maxSize exceeded", () => {
    const evicted: string[] = [];
    const s = createSkillStore({
      maxSize: 2,
      onEvicted: (r) => evicted.push(r.draft.name),
    });
    s.add(rec("a"));
    s.add(rec("b"));
    s.add(rec("c"));
    expect(s.size()).toBe(2);
    expect(s.has("a")).toBe(false);
    expect(evicted).toEqual(["a"]);
  });

  test("get() bumps to MRU and protects from eviction", () => {
    const evicted: string[] = [];
    const s = createSkillStore({
      maxSize: 2,
      onEvicted: (r) => evicted.push(r.draft.name),
    });
    s.add(rec("a"));
    s.add(rec("b"));
    s.get("a"); // bump a
    s.add(rec("c"));
    expect(s.has("a")).toBe(true);
    expect(s.has("b")).toBe(false);
    expect(evicted).toEqual(["b"]);
  });

  test("re-adding same record bumps recency", () => {
    const s = createSkillStore({ maxSize: 2 });
    s.add(rec("a"));
    s.add(rec("b"));
    s.add(rec("a")); // duplicate, but bumps
    s.add(rec("c"));
    expect(s.has("a")).toBe(true);
    expect(s.has("b")).toBe(false);
  });

  test("list() returns MRU-first order", () => {
    const s = createSkillStore();
    s.add(rec("a"));
    s.add(rec("b"));
    s.add(rec("c"));
    expect(s.list().map((r) => r.draft.name)).toEqual(["c", "b", "a"]);
  });

  test("rejects non-positive maxSize", () => {
    expect(() => createSkillStore({ maxSize: 0 })).toThrow();
    expect(() => createSkillStore({ maxSize: -1 })).toThrow();
  });

  test("Infinity maxSize never evicts", () => {
    const evicted: string[] = [];
    const s = createSkillStore({ onEvicted: (r) => evicted.push(r.draft.name) });
    for (let i = 0; i < 100; i += 1) s.add(rec(`s${i}`));
    expect(s.size()).toBe(100);
    expect(evicted).toEqual([]);
  });

  test("dedupes by draftHash even when admitted under a different name", () => {
    const s = createSkillStore();
    expect(s.add(rec("alpha", "shared-hash"))).toBe("added");
    // Same content (same draftHash), different name — must NOT consume a
    // second LRU slot.
    expect(s.add(rec("beta", "shared-hash"))).toBe("duplicate");
    expect(s.size()).toBe(1);
    expect(s.has("alpha")).toBe(true);
    expect(s.has("beta")).toBe(false);
  });

  test("hash dedupe survives delete (slot freed for genuine new content)", () => {
    const s = createSkillStore();
    s.add(rec("alpha", "shared-hash"));
    expect(s.delete("alpha")).toBe(true);
    expect(s.add(rec("beta", "shared-hash"))).toBe("added");
    expect(s.size()).toBe(1);
  });
});
