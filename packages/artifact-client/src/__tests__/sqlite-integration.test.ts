/**
 * Integration test for SqliteArtifactStore with file-based persistence.
 *
 * Verifies that data survives across store instances (open → write → close → reopen → read).
 * Uses a temp file that is cleaned up after each test.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeContentHash } from "../hash.js";
import { createSqliteArtifactStore } from "../sqlite-store.js";
import type { Artifact } from "../types.js";
import { artifactId } from "../types.js";
import { runArtifactStoreContractTests } from "./store-contract.js";

function makeTmpPath(): string {
  return join(
    tmpdir(),
    `koi-artifact-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
  );
}

function makeArtifact(overrides: Partial<Artifact> & { readonly id: Artifact["id"] }): Artifact {
  return {
    name: "test-artifact",
    description: "A test artifact",
    content: '{"hello":"world"}',
    contentType: "application/json",
    sizeBytes: new TextEncoder().encode('{"hello":"world"}').byteLength,
    tags: ["test"],
    metadata: {},
    createdBy: "test-agent",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Contract suite on file-backed SQLite (not :memory:)
// ---------------------------------------------------------------------------
describe("SqliteArtifactStore (file-backed)", () => {
  const dbPaths: string[] = [];

  afterEach(() => {
    for (const p of dbPaths) {
      try {
        unlinkSync(p);
      } catch {
        // already cleaned up
      }
      try {
        unlinkSync(`${p}-wal`);
      } catch {
        // WAL file may not exist
      }
      try {
        unlinkSync(`${p}-shm`);
      } catch {
        // SHM file may not exist
      }
    }
    dbPaths.length = 0;
  });

  runArtifactStoreContractTests(() => {
    const dbPath = makeTmpPath();
    dbPaths.push(dbPath);
    return createSqliteArtifactStore({ dbPath });
  });
});

// ---------------------------------------------------------------------------
// Persistence across store instances
// ---------------------------------------------------------------------------
describe("SqliteArtifactStore persistence", () => {
  let dbPath: string;

  afterEach(() => {
    try {
      unlinkSync(dbPath);
    } catch {
      // already cleaned up
    }
    try {
      unlinkSync(`${dbPath}-wal`);
    } catch {
      // WAL file may not exist
    }
    try {
      unlinkSync(`${dbPath}-shm`);
    } catch {
      // SHM file may not exist
    }
  });

  test("data survives close and reopen", async () => {
    dbPath = makeTmpPath();

    // Write with first instance
    const store1 = createSqliteArtifactStore({ dbPath });
    const artifact = makeArtifact({
      id: artifactId("persist-1"),
      name: "persistent-artifact",
      tags: ["durable", "sqlite"],
      metadata: { version: 1 },
    });
    const saveResult = await store1.save(artifact);
    expect(saveResult.ok).toBe(true);
    store1.close();

    // Read with second instance
    const store2 = createSqliteArtifactStore({ dbPath });
    const loadResult = await store2.load(artifactId("persist-1"));
    expect(loadResult.ok).toBe(true);
    if (loadResult.ok) {
      expect(loadResult.value.name).toBe("persistent-artifact");
      expect(loadResult.value.tags).toEqual(["durable", "sqlite"]);
      expect(loadResult.value.metadata).toEqual({ version: 1 });
      expect(loadResult.value.content).toBe('{"hello":"world"}');
    }
    store2.close();
  });

  test("updates persist across reopens", async () => {
    dbPath = makeTmpPath();

    // Save original
    const store1 = createSqliteArtifactStore({ dbPath });
    await store1.save(
      makeArtifact({
        id: artifactId("persist-update"),
        name: "original-name",
        tags: ["v1"],
      }),
    );

    // Update in same instance
    await store1.update(artifactId("persist-update"), {
      name: "updated-name",
      tags: ["v2", "modified"],
      content: "new-content",
    });
    store1.close();

    // Verify in new instance
    const store2 = createSqliteArtifactStore({ dbPath });
    const result = await store2.load(artifactId("persist-update"));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.name).toBe("updated-name");
      expect(result.value.tags).toEqual(["modified", "v2"]);
      expect(result.value.content).toBe("new-content");
      expect(result.value.sizeBytes).toBe(new TextEncoder().encode("new-content").byteLength);
    }
    store2.close();
  });

  test("remove persists across reopens", async () => {
    dbPath = makeTmpPath();

    const store1 = createSqliteArtifactStore({ dbPath });
    await store1.save(makeArtifact({ id: artifactId("persist-rm") }));
    await store1.remove(artifactId("persist-rm"));
    store1.close();

    const store2 = createSqliteArtifactStore({ dbPath });
    const result = await store2.load(artifactId("persist-rm"));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("NOT_FOUND");
    }
    store2.close();
  });

  test("search works across reopens", async () => {
    dbPath = makeTmpPath();
    const now = Date.now();

    const store1 = createSqliteArtifactStore({ dbPath });
    await store1.save(
      makeArtifact({
        id: artifactId("persist-s1"),
        tags: ["search", "alpha"],
        createdBy: "agent-x",
        createdAt: now - 1000,
        updatedAt: now - 1000,
      }),
    );
    await store1.save(
      makeArtifact({
        id: artifactId("persist-s2"),
        tags: ["search", "beta"],
        createdBy: "agent-y",
        createdAt: now,
        updatedAt: now,
      }),
    );
    store1.close();

    const store2 = createSqliteArtifactStore({ dbPath });

    // Tag filter
    const tagResult = await store2.search({ tags: ["search", "alpha"] });
    expect(tagResult.ok).toBe(true);
    if (tagResult.ok) {
      expect(tagResult.value.items.length).toBe(1);
      expect(tagResult.value.items[0]?.id).toBe(artifactId("persist-s1"));
    }

    // createdBy filter
    const byResult = await store2.search({ createdBy: "agent-y" });
    expect(byResult.ok).toBe(true);
    if (byResult.ok) {
      expect(byResult.value.items.length).toBe(1);
      expect(byResult.value.items[0]?.id).toBe(artifactId("persist-s2"));
    }

    // Total count
    const allResult = await store2.search({});
    expect(allResult.ok).toBe(true);
    if (allResult.ok) {
      expect(allResult.value.total).toBe(2);
    }

    store2.close();
  });

  test("content hash persists correctly", async () => {
    dbPath = makeTmpPath();
    const content = "hash-persistence-test";
    const hash = await computeContentHash(content);

    const store1 = createSqliteArtifactStore({ dbPath });
    await store1.save(
      makeArtifact({
        id: artifactId("persist-hash"),
        content,
        contentHash: hash,
        sizeBytes: new TextEncoder().encode(content).byteLength,
      }),
    );
    store1.close();

    const store2 = createSqliteArtifactStore({ dbPath });
    const result = await store2.load(artifactId("persist-hash"));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.contentHash).toBe(hash);
    }
    store2.close();
  });

  test("many artifacts with pagination across reopens", async () => {
    dbPath = makeTmpPath();

    const store1 = createSqliteArtifactStore({ dbPath });
    for (let i = 0; i < 25; i++) {
      await store1.save(
        makeArtifact({
          id: artifactId(`bulk-${String(i).padStart(3, "0")}`),
          name: `artifact-${String(i).padStart(3, "0")}`,
          createdAt: Date.now() + i,
          updatedAt: Date.now() + i,
        }),
      );
    }
    store1.close();

    const store2 = createSqliteArtifactStore({ dbPath });

    // First page
    const page1 = await store2.search({ limit: 10, offset: 0, sortBy: "name", sortOrder: "asc" });
    expect(page1.ok).toBe(true);
    if (page1.ok) {
      expect(page1.value.items.length).toBe(10);
      expect(page1.value.total).toBe(25);
      expect(page1.value.items[0]?.name).toBe("artifact-000");
    }

    // Third page
    const page3 = await store2.search({ limit: 10, offset: 20, sortBy: "name", sortOrder: "asc" });
    expect(page3.ok).toBe(true);
    if (page3.ok) {
      expect(page3.value.items.length).toBe(5);
      expect(page3.value.total).toBe(25);
      expect(page3.value.items[0]?.name).toBe("artifact-020");
    }

    store2.close();
  });
});
