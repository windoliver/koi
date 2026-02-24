import { describe, expect, test } from "bun:test";
import { createInMemoryPlaybookStore, createInMemoryTrajectoryStore } from "./stores.js";
import type { Playbook, TrajectoryEntry } from "./types.js";

function makeEntry(overrides?: Partial<TrajectoryEntry>): TrajectoryEntry {
  return {
    turnIndex: 0,
    timestamp: 1000,
    kind: "tool_call",
    identifier: "tool-a",
    outcome: "success",
    durationMs: 50,
    ...overrides,
  };
}

function makePlaybook(overrides?: Partial<Playbook>): Playbook {
  return {
    id: "pb-1",
    title: "Test Playbook",
    strategy: "Do the thing",
    tags: ["test"],
    confidence: 0.8,
    source: "curated",
    createdAt: 1000,
    updatedAt: 1000,
    sessionCount: 1,
    ...overrides,
  };
}

describe("createInMemoryTrajectoryStore", () => {
  test("append and getSession roundtrip", async () => {
    const store = createInMemoryTrajectoryStore();
    const entries = [makeEntry(), makeEntry({ turnIndex: 1 })];
    await store.append("s1", entries);
    const result = await store.getSession("s1");
    expect(result).toHaveLength(2);
    expect(result[0]?.turnIndex).toBe(0);
    expect(result[1]?.turnIndex).toBe(1);
  });

  test("getSession returns empty for unknown session", async () => {
    const store = createInMemoryTrajectoryStore();
    const result = await store.getSession("unknown");
    expect(result).toHaveLength(0);
  });

  test("append concatenates entries across calls", async () => {
    const store = createInMemoryTrajectoryStore();
    await store.append("s1", [makeEntry({ turnIndex: 0 })]);
    await store.append("s1", [makeEntry({ turnIndex: 1 })]);
    const result = await store.getSession("s1");
    expect(result).toHaveLength(2);
  });

  test("listSessions returns all session IDs", async () => {
    const store = createInMemoryTrajectoryStore();
    await store.append("s1", [makeEntry()]);
    await store.append("s2", [makeEntry()]);
    const sessions = await store.listSessions();
    expect(sessions).toContain("s1");
    expect(sessions).toContain("s2");
  });

  test("listSessions respects limit", async () => {
    const store = createInMemoryTrajectoryStore();
    await store.append("s1", [makeEntry()]);
    await store.append("s2", [makeEntry()]);
    await store.append("s3", [makeEntry()]);
    const sessions = await store.listSessions({ limit: 2 });
    expect(sessions).toHaveLength(2);
  });
});

describe("createInMemoryPlaybookStore", () => {
  test("save and get roundtrip", async () => {
    const store = createInMemoryPlaybookStore();
    const pb = makePlaybook();
    await store.save(pb);
    const result = await store.get("pb-1");
    expect(result).toEqual(pb);
  });

  test("get returns undefined for missing playbook", async () => {
    const store = createInMemoryPlaybookStore();
    const result = await store.get("missing");
    expect(result).toBeUndefined();
  });

  test("list returns all playbooks", async () => {
    const store = createInMemoryPlaybookStore();
    await store.save(makePlaybook({ id: "pb-1" }));
    await store.save(makePlaybook({ id: "pb-2" }));
    const result = await store.list();
    expect(result).toHaveLength(2);
  });

  test("list filters by minConfidence", async () => {
    const store = createInMemoryPlaybookStore();
    await store.save(makePlaybook({ id: "pb-1", confidence: 0.9 }));
    await store.save(makePlaybook({ id: "pb-2", confidence: 0.2 }));
    const result = await store.list({ minConfidence: 0.5 });
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe("pb-1");
  });

  test("list filters by tags", async () => {
    const store = createInMemoryPlaybookStore();
    await store.save(makePlaybook({ id: "pb-1", tags: ["perf"] }));
    await store.save(makePlaybook({ id: "pb-2", tags: ["safety"] }));
    const result = await store.list({ tags: ["perf"] });
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe("pb-1");
  });

  test("list filters by both tags and minConfidence", async () => {
    const store = createInMemoryPlaybookStore();
    await store.save(makePlaybook({ id: "pb-1", tags: ["perf"], confidence: 0.9 }));
    await store.save(makePlaybook({ id: "pb-2", tags: ["perf"], confidence: 0.2 }));
    await store.save(makePlaybook({ id: "pb-3", tags: ["safety"], confidence: 0.9 }));
    const result = await store.list({ tags: ["perf"], minConfidence: 0.5 });
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe("pb-1");
  });

  test("remove deletes a playbook and returns true", async () => {
    const store = createInMemoryPlaybookStore();
    await store.save(makePlaybook());
    const removed = await store.remove("pb-1");
    expect(removed).toBe(true);
    const result = await store.get("pb-1");
    expect(result).toBeUndefined();
  });

  test("remove returns false for missing playbook", async () => {
    const store = createInMemoryPlaybookStore();
    const removed = await store.remove("missing");
    expect(removed).toBe(false);
  });

  test("save overwrites existing playbook", async () => {
    const store = createInMemoryPlaybookStore();
    await store.save(makePlaybook({ id: "pb-1", title: "v1" }));
    await store.save(makePlaybook({ id: "pb-1", title: "v2" }));
    const result = await store.get("pb-1");
    expect(result?.title).toBe("v2");
  });
});
