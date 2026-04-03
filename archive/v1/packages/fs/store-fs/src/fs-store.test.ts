import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolArtifact } from "@koi/core";
import { brickId, DEFAULT_SANDBOXED_POLICY } from "@koi/core";
import { DEFAULT_PROVENANCE, runForgeStoreContractTests } from "@koi/test-utils";
import type { FsForgeStoreExtended } from "./fs-store.js";
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
    id: brickId(`brick_${Math.random().toString(36).slice(2, 10)}`),
    kind: "tool",
    name: "test-brick",
    description: "A test brick",
    scope: "agent",
    origin: "primordial",
    policy: DEFAULT_SANDBOXED_POLICY,
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
    const brick = createTestBrick({ id: brickId("brick_corrupt") });
    await store.save(brick);

    // Manually corrupt the file on disk
    const filePath = brickPath(testDir, brickId("brick_corrupt"));
    await writeFile(filePath, "{ invalid json !!!");

    // Load should fail with INTERNAL error (corrupted)
    const result = await store.load(brickId("brick_corrupt"));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("INTERNAL");
      expect(result.error.message).toContain("Corrupted");
    }
  });

  // 2. Schema mismatch (valid JSON, wrong shape)
  test("load returns INTERNAL for valid JSON with wrong schema", async () => {
    const store = await createFsForgeStore({ baseDir: testDir });
    const brick = createTestBrick({ id: brickId("brick_schema") });
    await store.save(brick);

    // Overwrite with valid JSON but missing required fields
    const filePath = brickPath(testDir, brickId("brick_schema"));
    await writeFile(filePath, JSON.stringify({ name: "incomplete" }));

    const result = await store.load(brickId("brick_schema"));
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
    const validBrick = createTestBrick({ id: brickId("brick_valid1") });
    await writeFile(validBrickPath, JSON.stringify(validBrick));

    const store = await createFsForgeStore({ baseDir: testDir });

    // .tmp should be cleaned
    const tmpFile = Bun.file(orphanedTmp);
    expect(await tmpFile.exists()).toBe(false);

    // Valid brick should be loaded
    const result = await store.exists(brickId("brick_valid1"));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe(true);
    }
  });

  // 4. Missing base directory — auto-created
  test("auto-creates missing base directory", async () => {
    const nestedDir = join(testDir, "deep", "nested", "store");
    const store = await createFsForgeStore({ baseDir: nestedDir });

    const brick = createTestBrick({ id: brickId("brick_nested") });
    const result = await store.save(brick);
    expect(result.ok).toBe(true);

    const loadResult = await store.load(brickId("brick_nested"));
    expect(loadResult.ok).toBe(true);
  });

  // 5. Concurrent save to same ID — last-write-wins
  test("concurrent saves to same ID result in last-write-wins", async () => {
    const store = await createFsForgeStore({ baseDir: testDir });
    const brick1 = createTestBrick({ id: brickId("brick_concurrent"), name: "first" });
    const brick2 = createTestBrick({ id: brickId("brick_concurrent"), name: "second" });

    // Fire both saves concurrently
    const [r1, r2] = await Promise.all([store.save(brick1), store.save(brick2)]);
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);

    // One of them should win — the file should be valid JSON either way
    const loadResult = await store.load(brickId("brick_concurrent"));
    expect(loadResult.ok).toBe(true);
    if (loadResult.ok) {
      expect(["first", "second"]).toContain(loadResult.value.name);
    }
  });

  // 6. Hash shard directory auto-creation
  test("auto-creates shard directory on first write", async () => {
    const store = await createFsForgeStore({ baseDir: testDir });
    const brick = createTestBrick({ id: brickId("zz_new_shard") });

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
    const brick = createTestBrick({ id: brickId("brick_persist") });
    await store1.save(brick);

    // Create a new store instance pointing at the same directory
    const store2 = await createFsForgeStore({ baseDir: testDir });
    const result = await store2.load(brickId("brick_persist"));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.id).toBe(brickId("brick_persist"));
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

// ---------------------------------------------------------------------------
// Filesystem watcher tests
// ---------------------------------------------------------------------------

describe("FsForgeStore watcher", () => {
  let testDir: string;
  // let justified: mutable store refs for cleanup in afterEach
  let storesToDispose: FsForgeStoreExtended[];

  beforeEach(async () => {
    testDir = await freshDir();
    storesToDispose = [];
  });

  afterEach(() => {
    for (const store of storesToDispose) {
      store.dispose();
    }
  });

  /** Create a watching store and track it for cleanup. */
  async function watchingStore(dir?: string): Promise<FsForgeStoreExtended> {
    const store = await createFsForgeStore({ baseDir: dir ?? testDir, watch: true });
    storesToDispose.push(store);
    return store;
  }

  /** Create a non-watching store and track it for cleanup. */
  async function plainStore(dir?: string): Promise<FsForgeStoreExtended> {
    const store = await createFsForgeStore({ baseDir: dir ?? testDir });
    storesToDispose.push(store);
    return store;
  }

  test("external file write triggers watch", async () => {
    // Store A watches the directory
    const storeA = await watchingStore();
    const listener = mock(() => {});
    storeA.watch?.(listener);

    // Store B (non-watching) writes a brick to the same directory
    const storeB = await plainStore();
    const brick = createTestBrick({ id: brickId("brick_ext_write") });
    await storeB.save(brick);

    // Wait for watcher debounce (100ms) + margin
    await new Promise((r) => setTimeout(r, 300));

    expect(listener).toHaveBeenCalled();

    // Store A should see the brick now
    const result = await storeA.exists(brickId("brick_ext_write"));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe(true);
    }
  });

  test("programmatic save does not double-fire watch", async () => {
    const store = await watchingStore();
    const listener = mock(() => {});
    store.watch?.(listener);

    // Single programmatic save
    const brick = createTestBrick({ id: brickId("brick_no_double") });
    await store.save(brick);

    // Wait for watcher debounce to settle
    await new Promise((r) => setTimeout(r, 300));

    // Should fire exactly once (the programmatic mutation's immediate notification).
    // The watcher rescan may also detect the change, but the index is already updated
    // so computeIndexDiff returns no events → no duplicate.
    expect(listener).toHaveBeenCalledTimes(1);
  });

  test("manually dropped valid JSON triggers watch", async () => {
    const store = await watchingStore();
    const listener = mock(() => {});
    store.watch?.(listener);

    // Manually write a valid brick JSON to the correct shard path
    const brick = createTestBrick({ id: brickId("brick_dropped") });
    const shard = shardDir(testDir, brick.id);
    await mkdir(shard, { recursive: true });
    const filePath = brickPath(testDir, brick.id);
    await Bun.write(filePath, JSON.stringify(brick));

    // Wait for watcher
    await new Promise((r) => setTimeout(r, 300));

    expect(listener).toHaveBeenCalled();

    // Store should now see the brick
    const result = await store.exists(brickId("brick_dropped"));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe(true);
    }
  });

  test("dispose stops watcher (no further notifications)", async () => {
    const store = await watchingStore();
    const listener = mock(() => {});
    store.watch?.(listener);

    // Dispose the store
    store.dispose();

    // Remove from cleanup list since already disposed
    storesToDispose = storesToDispose.filter((s) => s !== store);

    // External write after dispose
    const storeB = await plainStore();
    const brick = createTestBrick({ id: brickId("brick_after_dispose") });
    await storeB.save(brick);

    // Wait for watcher
    await new Promise((r) => setTimeout(r, 300));

    // Listener should NOT have been called
    expect(listener).not.toHaveBeenCalled();
  });

  test("watch: false (default) does not detect external changes", async () => {
    // Store A without watcher
    const storeA = await plainStore();
    const listener = mock(() => {});
    storeA.watch?.(listener);

    // Store B saves a brick
    const storeB = await plainStore();
    const brick = createTestBrick({ id: brickId("brick_no_watch") });
    await storeB.save(brick);

    // Wait generously
    await new Promise((r) => setTimeout(r, 300));

    // Store A's listener should NOT be called (no watcher)
    expect(listener).not.toHaveBeenCalled();

    // Store A should NOT see the brick (no rescan)
    const result = await storeA.exists(brickId("brick_no_watch"));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe(false);
    }
  });
});
