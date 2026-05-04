import { describe, expect, test } from "bun:test";

import type { StructuredPlaybook } from "@koi/ace-types";
import { createFakeNexusTransport } from "@koi/fs-nexus/testing";

import { createNexusStructuredPlaybookStore } from "../structured.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function spb(id: string, tags: readonly string[] = []): StructuredPlaybook {
  return {
    id,
    title: "t",
    sections: [
      {
        name: "Errors",
        slug: "errors",
        bullets: [
          {
            id: "b1",
            content: "always check existence",
            helpful: 1,
            harmful: 0,
            createdAt: 0,
            updatedAt: 0,
          },
        ],
      },
    ],
    tags,
    source: "curated",
    createdAt: 0,
    updatedAt: 0,
    sessionCount: 1,
    version: 1,
  };
}

function newStore() {
  return createNexusStructuredPlaybookStore({ transport: createFakeNexusTransport() });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createNexusStructuredPlaybookStore", () => {
  test("save → get round-trip", async () => {
    const store = newStore();
    await store.save(spb("a"));
    const got = await store.get("a");
    expect(got?.id).toBe("a");
    expect(got?.sections[0]?.slug).toBe("errors");
  });

  test("missing returns undefined", async () => {
    const store = newStore();
    expect(await store.get("missing")).toBeUndefined();
  });

  test("list filters by tag", async () => {
    const store = newStore();
    await store.save(spb("a", ["x", "y"]));
    await store.save(spb("b", ["z"]));
    await store.save(spb("c", ["x"]));
    const tagged = await store.list({ tags: ["y"] });
    expect(tagged.map((p) => p.id).sort()).toEqual(["a"]);
  });

  test("remove deletes", async () => {
    const store = newStore();
    await store.save(spb("r"));
    expect(await store.remove("r")).toBe(true);
    expect(await store.get("r")).toBeUndefined();
  });

  test("remove of missing returns false", async () => {
    const store = newStore();
    expect(await store.remove("nope")).toBe(false);
  });

  test("getVersion returns undefined (lineage not stored)", async () => {
    const store = newStore();
    await store.save(spb("v"));
    expect(await store.getVersion?.("v", 1)).toBeUndefined();
  });

  // --- contract parity tests (ported from sqlite sibling) ---

  test("list filters by multiple tags with AND semantics", async () => {
    // Verifies that when multiple tags are requested, ALL must match (AND),
    // not just any one of them (OR). Mirrors sqlite filterByTags behaviour.
    const store = newStore();
    await store.save(spb("one-tag", ["x"]));
    await store.save(spb("two-tags", ["x", "y"]));
    await store.save(spb("other", ["z"]));

    // tags=["x","y"] → only "two-tags" has both; "one-tag" has only "x"
    const filtered = await store.list({ tags: ["x", "y"] });
    expect(filtered.map((p) => p.id)).toEqual(["two-tags"]);
  });

  test("save with same id and different version is last-write-wins", async () => {
    // DIVERGENCE vs sqlite: sqlite enforces version-CAS (same-version different content
    // throws; lower-version save is rejected). Nexus is last-write-wins — any save
    // overwrites the current file regardless of version. Documented in
    // docs/L2/playbook-store-nexus.md.
    const store = newStore();
    await store.save({ ...spb("p"), version: 2, title: "v2" });
    await store.save({ ...spb("p"), version: 3, title: "v3" });
    expect((await store.get("p"))?.version).toBe(3);
    expect((await store.get("p"))?.title).toBe("v3");
    // sqlite would throw here if v2 were re-saved after v3 (out-of-order);
    // nexus allows it (last-write-wins).
    await store.save({ ...spb("p"), version: 2, title: "rollback" });
    expect((await store.get("p"))?.version).toBe(2);
  });

  // --- ACE ID path-safety regression tests (Finding 1) ---

  test("save with id containing '/' is rejected with validation error", async () => {
    const store = newStore();
    await expect(store.save(spb("a/b"))).rejects.toThrow("Structured Playbook ID");
  });

  test("save with id containing '..' is rejected", async () => {
    const store = newStore();
    await expect(store.save(spb("a..b"))).rejects.toThrow("Structured Playbook ID");
  });

  test("save 'a:b' and 'a_b' produce distinct files — no collision", async () => {
    const store = newStore();
    await store.save({ ...spb("a:b"), version: 1 });
    await store.save({ ...spb("a_b"), version: 2 });
    expect((await store.get("a:b"))?.version).toBe(1);
    expect((await store.get("a_b"))?.version).toBe(2);
    const all = await store.list();
    expect(all.map((p) => p.id).sort()).toEqual(["a:b", "a_b"]);
  });
});
