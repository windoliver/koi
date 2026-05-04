import { describe, expect, test } from "bun:test";

import type { Playbook } from "@koi/ace-types";
import { createFakeNexusTransport } from "@koi/fs-nexus/testing";

import { createNexusPlaybookStore } from "../playbook.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function pb(id: string, confidence = 0.5, tags: readonly string[] = []): Playbook {
  return {
    id,
    title: "t",
    strategy: "s",
    tags,
    confidence,
    source: "curated",
    createdAt: 0,
    updatedAt: 0,
    sessionCount: 1,
    version: 1,
  };
}

function newStore() {
  return createNexusPlaybookStore({ transport: createFakeNexusTransport() });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createNexusPlaybookStore", () => {
  test("save → get round-trip", async () => {
    const store = newStore();
    await store.save(pb("a"));
    const got = await store.get("a");
    expect(got?.id).toBe("a");
    expect(got?.confidence).toBe(0.5);
  });

  test("missing returns undefined", async () => {
    const store = newStore();
    expect(await store.get("missing")).toBeUndefined();
  });

  test("list filters by minConfidence", async () => {
    const store = newStore();
    await store.save(pb("lo", 0.1));
    await store.save(pb("hi", 0.9));
    await store.save(pb("mid", 0.5));
    const high = await store.list({ minConfidence: 0.5 });
    expect(high.map((p) => p.id).sort()).toEqual(["hi", "mid"]);
  });

  test("list filters by tag", async () => {
    const store = newStore();
    await store.save(pb("a", 0.5, ["x", "y"]));
    await store.save(pb("b", 0.5, ["z"]));
    await store.save(pb("c", 0.5, ["x"]));
    const tagged = await store.list({ tags: ["y"] });
    expect(tagged.map((p) => p.id).sort()).toEqual(["a"]);
  });

  test("remove deletes", async () => {
    const store = newStore();
    await store.save(pb("r"));
    expect(await store.remove("r")).toBe(true);
    expect(await store.get("r")).toBeUndefined();
  });

  test("remove of missing returns false", async () => {
    const store = newStore();
    expect(await store.remove("nope")).toBe(false);
  });

  // --- contract parity tests (ported from sqlite sibling) ---

  test("list filters by tags AND minConfidence together (intersection)", async () => {
    // Mirrors sqlite "filters list by minConfidence and tags".
    // Verifies that tags uses AND semantics (ALL requested tags must be present)
    // and that minConfidence + tags filters compose correctly.
    const store = newStore();
    await store.save(pb("lo", 0.1, ["x"]));
    await store.save(pb("hi", 0.9, ["x", "y"]));
    await store.save(pb("mid", 0.5, ["z"]));

    // minConfidence=0.5 → "hi" and "mid" (not "lo" at 0.1)
    const high = await store.list({ minConfidence: 0.5 });
    expect(high.map((p) => p.id).sort()).toEqual(["hi", "mid"]);

    // tags=["x","y"] with AND semantics → only "hi" (has both x and y; "lo" has only x)
    const tagged = await store.list({ tags: ["x", "y"] });
    expect(tagged.map((p) => p.id)).toEqual(["hi"]);
  });

  test("save overwrites existing playbook (last-write-wins)", async () => {
    // Nexus is last-write-wins; sqlite uses version-CAS. Divergence is documented.
    const store = newStore();
    await store.save(pb("p", 0.5));
    await store.save({ ...pb("p", 0.9), title: "updated" });
    const got = await store.get("p");
    expect(got?.confidence).toBe(0.9);
    expect(got?.title).toBe("updated");
  });
});
