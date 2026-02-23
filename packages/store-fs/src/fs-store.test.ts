import { beforeEach, describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolArtifact } from "@koi/core";
import { runForgeStoreContractTests } from "@koi/test-utils";
import { createFsForgeStore } from "./fs-store.js";
import { brickPath, shardDir } from "./paths.js";

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

let testCounter = 0;

async function freshDir(): Promise<string> {
  testCounter += 1;
  const dir = join(tmpdir(), `koi-store-fs-test-${Date.now()}-${testCounter}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

function createTestBrick(overrides?: Partial<ToolArtifact>): ToolArtifact {
  return {
    id: `brick_${Math.random().toString(36).slice(2, 10)}`,
    kind: "tool",
    name: "test-brick",
    description: "A test brick",
    scope: "agent",
    trustTier: "sandbox",
    lifecycle: "active",
    createdBy: "agent-1",
    createdAt: Date.now(),
    version: "0.0.1",
    tags: [],
    usageCount: 0,
    contentHash: "test-hash",
    implementation: "return 1;",
    inputSchema: { type: "object" },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Contract tests
// ---------------------------------------------------------------------------

runForgeStoreContractTests(async () => {
  const dir = await freshDir();
  return createFsForgeStore({ baseDir: dir });
});

// ---------------------------------------------------------------------------
// Filesystem-specific edge cases
// ---------------------------------------------------------------------------

describe("FsForgeStore edge cases", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await freshDir();
  });

  // 1. Corrupted JSON file
  test("load returns INTERNAL for corrupted JSON file", async () => {
    const store = await createFsForgeStore({ baseDir: testDir });
    // Save a valid brick to create the shard directory and index entry
    const brick = createTestBrick({ id: "brick_corrupt" });
    await store.save(brick);

    // Manually corrupt the file on disk
    const filePath = brickPath(testDir, "brick_corrupt");
    await writeFile(filePath, "{ invalid json !!!");

    // Load should fail with INTERNAL error (corrupted)
    const result = await store.load("brick_corrupt");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("INTERNAL");
      expect(result.error.message).toContain("Corrupted");
    }
  });

  // 2. Schema mismatch (valid JSON, wrong shape)
  test("load returns INTERNAL for valid JSON with wrong schema", async () => {
    const store = await createFsForgeStore({ baseDir: testDir });
    const brick = createTestBrick({ id: "brick_schema" });
    await store.save(brick);

    // Overwrite with valid JSON but missing required fields
    const filePath = brickPath(testDir, "brick_schema");
    await writeFile(filePath, JSON.stringify({ name: "incomplete" }));

    const result = await store.load("brick_schema");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("INTERNAL");
    }
  });

  // 3. Orphaned .tmp cleanup on startup
  test("cleans orphaned .tmp files on startup", async () => {
    // Create shard directory with orphaned tmp file
    const shard = shardDir(testDir, "brick_orphan");
    await mkdir(shard, { recursive: true });
    const orphanedTmp = join(shard, "brick_orphan.abc123.tmp");
    await writeFile(orphanedTmp, "partial write");

    // Also write a valid brick to ensure it's preserved
    const validBrickPath = brickPath(testDir, "brick_valid1");
    const validBrick = createTestBrick({ id: "brick_valid1" });
    await writeFile(validBrickPath, JSON.stringify(validBrick));

    const store = await createFsForgeStore({ baseDir: testDir });

    // .tmp should be cleaned
    const tmpFile = Bun.file(orphanedTmp);
    expect(await tmpFile.exists()).toBe(false);

    // Valid brick should be loaded
    const result = await store.exists("brick_valid1");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe(true);
    }
  });

  // 4. Missing base directory — auto-created
  test("auto-creates missing base directory", async () => {
    const nestedDir = join(testDir, "deep", "nested", "store");
    const store = await createFsForgeStore({ baseDir: nestedDir });

    const brick = createTestBrick({ id: "brick_nested" });
    const result = await store.save(brick);
    expect(result.ok).toBe(true);

    const loadResult = await store.load("brick_nested");
    expect(loadResult.ok).toBe(true);
  });

  // 5. Concurrent save to same ID — last-write-wins
  test("concurrent saves to same ID result in last-write-wins", async () => {
    const store = await createFsForgeStore({ baseDir: testDir });
    const brick1 = createTestBrick({ id: "brick_concurrent", name: "first" });
    const brick2 = createTestBrick({ id: "brick_concurrent", name: "second" });

    // Fire both saves concurrently
    const [r1, r2] = await Promise.all([store.save(brick1), store.save(brick2)]);
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);

    // One of them should win — the file should be valid JSON either way
    const loadResult = await store.load("brick_concurrent");
    expect(loadResult.ok).toBe(true);
    if (loadResult.ok) {
      expect(["first", "second"]).toContain(loadResult.value.name);
    }
  });

  // 6. Hash shard directory auto-creation
  test("auto-creates shard directory on first write", async () => {
    const store = await createFsForgeStore({ baseDir: testDir });
    const brick = createTestBrick({ id: "zz_new_shard" });

    const result = await store.save(brick);
    expect(result.ok).toBe(true);

    // Shard directory 'zz' should exist
    const shard = shardDir(testDir, "zz_new_shard");
    const shardFile = Bun.file(join(shard, "zz_new_shard.json"));
    expect(await shardFile.exists()).toBe(true);
  });

  // 7. Empty store operations
  test("empty store search returns empty array", async () => {
    const store = await createFsForgeStore({ baseDir: testDir });
    const result = await store.search({});
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.length).toBe(0);
    }
  });

  // 8. Data survives re-creation (persistence test)
  test("data persists across store re-creation", async () => {
    const store1 = await createFsForgeStore({ baseDir: testDir });
    const brick = createTestBrick({ id: "brick_persist" });
    await store1.save(brick);

    // Create a new store instance pointing at the same directory
    const store2 = await createFsForgeStore({ baseDir: testDir });
    const result = await store2.load("brick_persist");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.id).toBe("brick_persist");
      expect(result.value.name).toBe("test-brick");
    }
  });

  // Bonus: cleanOrphanedTmp = false preserves .tmp files
  test("cleanOrphanedTmp=false preserves .tmp files", async () => {
    const shard = shardDir(testDir, "brick_keep");
    await mkdir(shard, { recursive: true });
    const orphanedTmp = join(shard, "brick_keep.xyz789.tmp");
    await writeFile(orphanedTmp, "partial write");

    await createFsForgeStore({ baseDir: testDir, cleanOrphanedTmp: false });

    const tmpFile = Bun.file(orphanedTmp);
    expect(await tmpFile.exists()).toBe(true);
  });
});
