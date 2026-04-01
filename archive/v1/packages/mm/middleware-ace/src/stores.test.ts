import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createInMemoryPlaybookStore,
  createInMemoryStructuredPlaybookStore,
  createInMemoryTrajectoryStore,
} from "./stores.js";
import {
  createSqlitePlaybookStore,
  createSqliteStructuredPlaybookStore,
  createSqliteTrajectoryStore,
} from "./stores-sqlite.js";
import type { Playbook, StructuredPlaybook, TrajectoryEntry } from "./types.js";

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

// ---------------------------------------------------------------------------
// SQLite store contract tests (Decision 10A — parameterized over backend)
// ---------------------------------------------------------------------------

function uniqueDbPath(): string {
  return join(tmpdir(), `koi-ace-test-${crypto.randomUUID()}.db`);
}

describe("createSqliteTrajectoryStore", () => {
  test("append and getSession roundtrip", async () => {
    const store = createSqliteTrajectoryStore({ dbPath: uniqueDbPath() });
    const entries = [makeEntry(), makeEntry({ turnIndex: 1 })];
    await store.append("s1", entries);
    const result = await store.getSession("s1");
    expect(result).toHaveLength(2);
    expect(result[0]?.turnIndex).toBe(0);
    expect(result[1]?.turnIndex).toBe(1);
  });

  test("getSession returns empty for unknown session", async () => {
    const store = createSqliteTrajectoryStore({ dbPath: uniqueDbPath() });
    const result = await store.getSession("unknown");
    expect(result).toHaveLength(0);
  });

  test("append concatenates entries across calls", async () => {
    const store = createSqliteTrajectoryStore({ dbPath: uniqueDbPath() });
    await store.append("s1", [makeEntry({ turnIndex: 0 })]);
    await store.append("s1", [makeEntry({ turnIndex: 1, identifier: "tool-b" })]);
    const result = await store.getSession("s1");
    expect(result).toHaveLength(2);
  });

  test("listSessions returns all session IDs", async () => {
    const store = createSqliteTrajectoryStore({ dbPath: uniqueDbPath() });
    await store.append("s1", [makeEntry()]);
    await store.append("s2", [makeEntry()]);
    const sessions = await store.listSessions();
    expect(sessions).toContain("s1");
    expect(sessions).toContain("s2");
  });

  test("listSessions respects limit", async () => {
    const store = createSqliteTrajectoryStore({ dbPath: uniqueDbPath() });
    await store.append("s1", [makeEntry()]);
    await store.append("s2", [makeEntry()]);
    await store.append("s3", [makeEntry()]);
    const sessions = await store.listSessions({ limit: 2 });
    expect(sessions).toHaveLength(2);
  });

  test("preserves metadata and bulletIds", async () => {
    const store = createSqliteTrajectoryStore({ dbPath: uniqueDbPath() });
    await store.append("s1", [makeEntry({ metadata: { key: "value" }, bulletIds: ["b1", "b2"] })]);
    const result = await store.getSession("s1");
    expect(result[0]?.metadata).toEqual({ key: "value" });
    expect(result[0]?.bulletIds).toEqual(["b1", "b2"]);
  });
});

describe("createSqlitePlaybookStore", () => {
  test("save and get roundtrip", async () => {
    const store = createSqlitePlaybookStore({ dbPath: uniqueDbPath() });
    const pb = makePlaybook();
    await store.save(pb);
    const result = await store.get("pb-1");
    expect(result?.title).toBe("Test Playbook");
    expect(result?.confidence).toBe(0.8);
    expect(result?.tags).toEqual(["test"]);
  });

  test("get returns undefined for missing playbook", async () => {
    const store = createSqlitePlaybookStore({ dbPath: uniqueDbPath() });
    expect(await store.get("missing")).toBeUndefined();
  });

  test("list returns all playbooks", async () => {
    const store = createSqlitePlaybookStore({ dbPath: uniqueDbPath() });
    await store.save(makePlaybook({ id: "pb-1" }));
    await store.save(makePlaybook({ id: "pb-2" }));
    const result = await store.list();
    expect(result).toHaveLength(2);
  });

  test("list filters by minConfidence", async () => {
    const store = createSqlitePlaybookStore({ dbPath: uniqueDbPath() });
    await store.save(makePlaybook({ id: "pb-1", confidence: 0.9 }));
    await store.save(makePlaybook({ id: "pb-2", confidence: 0.2 }));
    const result = await store.list({ minConfidence: 0.5 });
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe("pb-1");
  });

  test("list filters by tags via junction table", async () => {
    const store = createSqlitePlaybookStore({ dbPath: uniqueDbPath() });
    await store.save(makePlaybook({ id: "pb-1", tags: ["perf"] }));
    await store.save(makePlaybook({ id: "pb-2", tags: ["safety"] }));
    const result = await store.list({ tags: ["perf"] });
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe("pb-1");
  });

  test("list filters by both tags and minConfidence", async () => {
    const store = createSqlitePlaybookStore({ dbPath: uniqueDbPath() });
    await store.save(makePlaybook({ id: "pb-1", tags: ["perf"], confidence: 0.9 }));
    await store.save(makePlaybook({ id: "pb-2", tags: ["perf"], confidence: 0.2 }));
    await store.save(makePlaybook({ id: "pb-3", tags: ["safety"], confidence: 0.9 }));
    const result = await store.list({ tags: ["perf"], minConfidence: 0.5 });
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe("pb-1");
  });

  test("remove deletes a playbook and returns true", async () => {
    const store = createSqlitePlaybookStore({ dbPath: uniqueDbPath() });
    await store.save(makePlaybook());
    expect(await store.remove("pb-1")).toBe(true);
    expect(await store.get("pb-1")).toBeUndefined();
  });

  test("remove returns false for missing playbook", async () => {
    const store = createSqlitePlaybookStore({ dbPath: uniqueDbPath() });
    expect(await store.remove("missing")).toBe(false);
  });

  test("save overwrites existing playbook", async () => {
    const store = createSqlitePlaybookStore({ dbPath: uniqueDbPath() });
    await store.save(makePlaybook({ id: "pb-1", title: "v1" }));
    await store.save(makePlaybook({ id: "pb-1", title: "v2" }));
    const result = await store.get("pb-1");
    expect(result?.title).toBe("v2");
  });

  test("save updates tags correctly on overwrite", async () => {
    const store = createSqlitePlaybookStore({ dbPath: uniqueDbPath() });
    await store.save(makePlaybook({ id: "pb-1", tags: ["old-tag"] }));
    await store.save(makePlaybook({ id: "pb-1", tags: ["new-tag"] }));
    const result = await store.get("pb-1");
    expect(result?.tags).toEqual(["new-tag"]);
  });
});

describe("createSqliteStructuredPlaybookStore", () => {
  function makeStructured(overrides?: Partial<StructuredPlaybook>): StructuredPlaybook {
    return {
      id: `spb-${crypto.randomUUID()}`,
      title: "Test Structured Playbook",
      sections: [
        {
          name: "Section A",
          slug: "section-a",
          bullets: [
            {
              id: "b1",
              content: "Bullet 1",
              helpful: 3,
              harmful: 0,
              createdAt: 1000,
              updatedAt: 1000,
            },
          ],
        },
      ],
      tags: ["test"],
      source: "curated",
      createdAt: 1000,
      updatedAt: 1000,
      sessionCount: 1,
      ...overrides,
    };
  }

  test("save and get roundtrip", async () => {
    const store = createSqliteStructuredPlaybookStore({ dbPath: uniqueDbPath() });
    const spb = makeStructured({ id: "spb-1" });
    await store.save(spb);
    const result = await store.get("spb-1");
    expect(result?.title).toBe("Test Structured Playbook");
    expect(result?.sections).toHaveLength(1);
    expect(result?.sections[0]?.bullets[0]?.content).toBe("Bullet 1");
  });

  test("get returns undefined for missing", async () => {
    const store = createSqliteStructuredPlaybookStore({ dbPath: uniqueDbPath() });
    expect(await store.get("missing")).toBeUndefined();
  });

  test("list returns all", async () => {
    const store = createSqliteStructuredPlaybookStore({ dbPath: uniqueDbPath() });
    await store.save(makeStructured({ id: "spb-1" }));
    await store.save(makeStructured({ id: "spb-2" }));
    expect(await store.list()).toHaveLength(2);
  });

  test("list filters by tags", async () => {
    const store = createSqliteStructuredPlaybookStore({ dbPath: uniqueDbPath() });
    await store.save(makeStructured({ id: "spb-1", tags: ["perf"] }));
    await store.save(makeStructured({ id: "spb-2", tags: ["safety"] }));
    const result = await store.list({ tags: ["perf"] });
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe("spb-1");
  });

  test("remove returns true for existing", async () => {
    const store = createSqliteStructuredPlaybookStore({ dbPath: uniqueDbPath() });
    await store.save(makeStructured({ id: "spb-1" }));
    expect(await store.remove("spb-1")).toBe(true);
    expect(await store.get("spb-1")).toBeUndefined();
  });

  test("remove returns false for missing", async () => {
    const store = createSqliteStructuredPlaybookStore({ dbPath: uniqueDbPath() });
    expect(await store.remove("nonexistent")).toBe(false);
  });

  test("preserves multi-section bullet structure", async () => {
    const store = createSqliteStructuredPlaybookStore({ dbPath: uniqueDbPath() });
    await store.save(
      makeStructured({
        id: "spb-1",
        sections: [
          {
            name: "A",
            slug: "a",
            bullets: [
              { id: "b1", content: "B1", helpful: 5, harmful: 1, createdAt: 1, updatedAt: 2 },
              { id: "b2", content: "B2", helpful: 3, harmful: 0, createdAt: 1, updatedAt: 2 },
            ],
          },
          {
            name: "B",
            slug: "b",
            bullets: [
              { id: "b3", content: "B3", helpful: 1, harmful: 2, createdAt: 1, updatedAt: 2 },
            ],
          },
        ],
      }),
    );
    const result = await store.get("spb-1");
    expect(result?.sections).toHaveLength(2);
    expect(result?.sections[0]?.bullets).toHaveLength(2);
    expect(result?.sections[1]?.bullets).toHaveLength(1);
  });
});

// In-memory StructuredPlaybookStore tests
describe("createInMemoryStructuredPlaybookStore", () => {
  function makeStructured(overrides?: Partial<StructuredPlaybook>): StructuredPlaybook {
    return {
      id: `spb-${crypto.randomUUID()}`,
      title: "Test Structured Playbook",
      sections: [
        {
          name: "Section A",
          slug: "section-a",
          bullets: [
            {
              id: "b1",
              content: "Bullet 1",
              helpful: 3,
              harmful: 0,
              createdAt: 1000,
              updatedAt: 1000,
            },
          ],
        },
      ],
      tags: ["test"],
      source: "curated",
      createdAt: 1000,
      updatedAt: 1000,
      sessionCount: 1,
      ...overrides,
    };
  }

  test("save and get roundtrip", async () => {
    const store = createInMemoryStructuredPlaybookStore();
    const spb = makeStructured({ id: "spb-1" });
    await store.save(spb);
    const result = await store.get("spb-1");
    expect(result?.title).toBe("Test Structured Playbook");
  });

  test("list filters by tags", async () => {
    const store = createInMemoryStructuredPlaybookStore();
    await store.save(makeStructured({ id: "spb-a", tags: ["perf"] }));
    await store.save(makeStructured({ id: "spb-b", tags: ["safety"] }));
    const result = await store.list({ tags: ["perf"] });
    expect(result).toHaveLength(1);
  });

  test("remove returns true for existing", async () => {
    const store = createInMemoryStructuredPlaybookStore();
    await store.save(makeStructured({ id: "spb-1" }));
    expect(await store.remove("spb-1")).toBe(true);
  });
});
