import { describe, expect, test } from "bun:test";

import type { Playbook } from "@koi/ace-types";

import { createInMemoryPlaybookStore, createInMemoryTrajectoryStore } from "./in-memory-store.js";

function pb(p: Partial<Playbook>): Playbook {
  return {
    id: "id",
    title: "t",
    strategy: "s",
    tags: [],
    confidence: 0.5,
    source: "curated",
    createdAt: 0,
    updatedAt: 0,
    sessionCount: 1,
    version: 1,
    ...p,
  };
}

describe("createInMemoryPlaybookStore", () => {
  test("seeds, lists, saves, removes", async () => {
    const store = createInMemoryPlaybookStore([pb({ id: "a" })]);
    expect(await store.get("a")).toBeDefined();
    await store.save(pb({ id: "b", confidence: 0.9 }));
    expect((await store.list()).length).toBe(2);
    expect(await store.remove("a")).toBe(true);
    expect(await store.get("a")).toBeUndefined();
  });

  test("filters list by minConfidence and tags", async () => {
    const store = createInMemoryPlaybookStore([
      pb({ id: "lo", confidence: 0.1, tags: ["x"] }),
      pb({ id: "hi", confidence: 0.9, tags: ["x", "y"] }),
      pb({ id: "mid", confidence: 0.5, tags: ["z"] }),
    ]);
    const high = await store.list({ minConfidence: 0.5 });
    expect(high.map((p) => p.id).sort()).toEqual(["hi", "mid"]);
    const tagged = await store.list({ tags: ["x", "y"] });
    expect(tagged.map((p) => p.id)).toEqual(["hi"]);
  });
});

describe("createInMemoryTrajectoryStore", () => {
  test("appends per session and lists", async () => {
    const store = createInMemoryTrajectoryStore();
    await store.append("s1", [
      {
        turnIndex: 0,
        timestamp: 0,
        kind: "tool_call",
        identifier: "x",
        outcome: "success",
        durationMs: 1,
      },
    ]);
    await store.append("s2", []);
    const s1 = await store.getSession("s1");
    expect(s1.length).toBe(1);
    expect((await store.listSessions()).length).toBe(2);
    expect((await store.listSessions({ limit: 1 })).length).toBe(1);
  });
});
