import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolArtifact } from "@koi/core";
import { brickId } from "@koi/core";
import { DEFAULT_PROVENANCE, runForgeStoreContractTests } from "@koi/test-utils";
import { createSqliteForgeStore, openForgeDb } from "./sqlite-store.js";

// ---------------------------------------------------------------------------
// Contract tests — :memory: DB for speed
// ---------------------------------------------------------------------------

runForgeStoreContractTests(() => {
  const db = new Database(":memory:");
  db.run("PRAGMA foreign_keys = ON");
  return createSqliteForgeStore({ db });
});

// ---------------------------------------------------------------------------
// SQLite-specific tests
// ---------------------------------------------------------------------------

function createToolBrick(overrides?: Partial<ToolArtifact>): ToolArtifact {
  return {
    id: brickId(`brick_${Math.random().toString(36).slice(2, 10)}`),
    kind: "tool",
    name: "test-tool",
    description: "A test tool",
    scope: "agent",
    trustTier: "sandbox",
    lifecycle: "active",
    provenance: DEFAULT_PROVENANCE,
    version: "0.0.1",
    tags: [],
    usageCount: 0,
    implementation: "return 1;",
    inputSchema: { type: "object" },
    ...overrides,
  };
}

describe("SQLite-specific", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    for (const dir of tempDirs) {
      await rm(dir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
  });

  async function makeTempDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "koi-sqlite-test-"));
    tempDirs.push(dir);
    return dir;
  }

  test("persistence: save → close → reopen → load", async () => {
    const dir = await makeTempDir();
    const dbPath = join(dir, "forge.db");

    // Save with first store
    const store1 = createSqliteForgeStore({ dbPath });
    const brick = createToolBrick({ id: brickId("brick_persist") });
    await store1.save(brick);
    store1.close();

    // Reopen and load
    const store2 = createSqliteForgeStore({ dbPath });
    const result = await store2.load(brickId("brick_persist"));
    store2.close();

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.id).toBe(brickId("brick_persist"));
      expect(result.value.name).toBe("test-tool");
    }
  });

  test("openForgeDb sets WAL mode and PRAGMAs", () => {
    const dir = tmpdir();
    const dbPath = join(dir, `koi-pragma-test-${Date.now()}.db`);

    const db = openForgeDb(dbPath);

    const journalMode = db.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get();
    expect(journalMode?.journal_mode).toBe("wal");

    const fk = db.query<{ foreign_keys: number }, []>("PRAGMA foreign_keys").get();
    expect(fk?.foreign_keys).toBe(1);

    const busyTimeout = db.query<{ timeout: number }, []>("PRAGMA busy_timeout").get();
    expect(busyTimeout?.timeout).toBe(5000);

    db.close();
    // Clean up
    try {
      Bun.spawnSync(["rm", "-f", dbPath, `${dbPath}-wal`, `${dbPath}-shm`]);
    } catch {
      // best-effort cleanup
    }
  });

  test("schema migration sets user_version = 2 and creates tables", () => {
    const db = new Database(":memory:");
    db.run("PRAGMA foreign_keys = ON");
    createSqliteForgeStore({ db });

    const row = db.query<{ user_version: number }, []>("PRAGMA user_version").get();
    expect(row?.user_version).toBe(2);

    // Verify tables exist by querying sqlite_master
    const tables = db
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('bricks', 'brick_tags') ORDER BY name",
      )
      .all();
    expect(tables.map((t) => t.name)).toEqual(["brick_tags", "bricks"]);

    db.close();
  });

  test("large artifact: save/load ~100KB implementation", async () => {
    const db = new Database(":memory:");
    db.run("PRAGMA foreign_keys = ON");
    const store = createSqliteForgeStore({ db });

    const largeImpl = "x".repeat(100_000);
    const brick = createToolBrick({
      id: brickId("brick_large"),
      implementation: largeImpl,
    });

    const saveResult = await store.save(brick);
    expect(saveResult.ok).toBe(true);

    const loadResult = await store.load(brickId("brick_large"));
    expect(loadResult.ok).toBe(true);
    if (loadResult.ok) {
      expect((loadResult.value as ToolArtifact).implementation.length).toBe(100_000);
    }

    db.close();
  });

  test("tag AND-subset: only bricks with ALL requested tags returned", async () => {
    const db = new Database(":memory:");
    db.run("PRAGMA foreign_keys = ON");
    const store = createSqliteForgeStore({ db });

    await store.save(createToolBrick({ id: brickId("b_ab"), tags: ["alpha", "beta"] }));
    await store.save(createToolBrick({ id: brickId("b_a"), tags: ["alpha"] }));
    await store.save(createToolBrick({ id: brickId("b_abc"), tags: ["alpha", "beta", "gamma"] }));
    await store.save(createToolBrick({ id: brickId("b_g"), tags: ["gamma"] }));

    const result = await store.search({ tags: ["alpha", "beta"] });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const ids = result.value.map((b) => b.id).sort();
      expect(ids).toEqual([brickId("b_ab"), brickId("b_abc")]);
    }

    db.close();
  });

  test("concurrent reads: WAL allows reader during write", async () => {
    const dir = await makeTempDir();
    const dbPath = join(dir, "forge-concurrent.db");

    // Writer
    const writer = createSqliteForgeStore({ dbPath });
    const brick = createToolBrick({ id: brickId("brick_wal") });
    await writer.save(brick);

    // Reader (separate connection via new store)
    const reader = createSqliteForgeStore({ dbPath });
    const result = await reader.load(brickId("brick_wal"));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.id).toBe(brickId("brick_wal"));
    }

    reader.close();
    writer.close();
  });

  test("search with text filter (case-insensitive)", async () => {
    const db = new Database(":memory:");
    db.run("PRAGMA foreign_keys = ON");
    const store = createSqliteForgeStore({ db });

    await store.save(
      createToolBrick({ id: brickId("b1"), name: "Math Calculator", description: "calc" }),
    );
    await store.save(
      createToolBrick({ id: brickId("b2"), name: "text-tool", description: "processes text" }),
    );

    const result = await store.search({ text: "math" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.length).toBe(1);
      expect(result.value[0]?.id).toBe(brickId("b1"));
    }

    db.close();
  });
});
