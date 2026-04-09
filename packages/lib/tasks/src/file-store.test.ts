import { beforeEach, describe, expect, test } from "bun:test";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Task } from "@koi/core";
import { taskItemId } from "@koi/core";
import { createFileTaskBoardStore } from "./file-store.js";
import { runTaskBoardStoreContract } from "./task-board-store.contract.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let testCounter = 0;

async function freshDir(): Promise<string> {
  testCounter += 1;
  const dir = join(tmpdir(), `koi-tasks-test-${Date.now()}-${testCounter}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

function createTestTask(id: string, overrides?: Partial<Task>): Task {
  return {
    id: taskItemId(id),
    subject: `Task ${id}`,
    description: `Task ${id}`,
    dependencies: [],
    retries: 0,
    version: 0,
    status: "pending",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Contract tests
// ---------------------------------------------------------------------------

runTaskBoardStoreContract(async () => {
  const dir = await freshDir();
  return createFileTaskBoardStore({ baseDir: dir });
});

// ---------------------------------------------------------------------------
// Filesystem-specific edge cases
// ---------------------------------------------------------------------------

describe("createFileTaskBoardStore — filesystem-specific", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await freshDir();
  });

  // FS-1: Corrupted JSON file — get() handles gracefully
  test("get returns undefined for corrupted JSON file", async () => {
    // Write a corrupted file before creating the store
    await writeFile(join(testDir, "task_1.json"), "{ invalid json !!!");

    const store = await createFileTaskBoardStore({ baseDir: testDir });
    const result = await store.get(taskItemId("task_1"));

    // Corrupted file should be treated as missing
    expect(result).toBeUndefined();
  });

  // FS-1b: Malformed version field — rejected, not coerced to 0
  test("rejects file with malformed version (string instead of number)", async () => {
    const task = { ...createTestTask("task_1"), version: "7" };
    await writeFile(join(testDir, "task_1.json"), JSON.stringify(task));

    const store = await createFileTaskBoardStore({ baseDir: testDir });
    const result = await store.get(taskItemId("task_1"));

    // Malformed version = invalid file, treated as missing
    expect(result).toBeUndefined();
  });

  // FS-1c: Invalid status value — rejected
  test("rejects file with invalid status literal", async () => {
    const task = { ...createTestTask("task_1"), status: "bogus" };
    await writeFile(join(testDir, "task_1.json"), JSON.stringify(task));

    const store = await createFileTaskBoardStore({ baseDir: testDir });
    expect(await store.get(taskItemId("task_1"))).toBeUndefined();
  });

  // FS-1d: Non-string dependency entries — rejected
  test("rejects file with non-string dependency entries", async () => {
    const task = { ...createTestTask("task_1"), dependencies: [42, null] };
    await writeFile(join(testDir, "task_1.json"), JSON.stringify(task));

    const store = await createFileTaskBoardStore({ baseDir: testDir });
    expect(await store.get(taskItemId("task_1"))).toBeUndefined();
  });

  // FS-1e: Missing version field (old file) — backfilled to 0
  test("backfills version to 0 when field is absent (backward compat)", async () => {
    const { version: _, ...taskWithoutVersion } = createTestTask("task_1");
    await writeFile(join(testDir, "task_1.json"), JSON.stringify(taskWithoutVersion));

    const store = await createFileTaskBoardStore({ baseDir: testDir });
    const result = await store.get(taskItemId("task_1"));

    expect(result).toBeDefined();
    expect(result?.version).toBe(0);
  });

  // FS-1f: Legacy file missing retries/createdAt/updatedAt/subject — backfilled
  test("loads legacy task file missing retries, timestamps, and subject", async () => {
    // Minimal old-format file: only id, description, status, dependencies
    const legacyTask = {
      id: "task_1",
      description: "Old task",
      status: "pending",
      dependencies: [],
    };
    await writeFile(join(testDir, "task_1.json"), JSON.stringify(legacyTask));

    const store = await createFileTaskBoardStore({ baseDir: testDir });
    const result = await store.get(taskItemId("task_1"));

    expect(result).toBeDefined();
    expect(result?.description).toBe("Old task");
    expect(result?.retries).toBe(0);
    expect(result?.version).toBe(0);
    expect(result?.createdAt).toBe(0);
    expect(result?.updatedAt).toBe(0);
    expect(result?.subject).toBe("Old task");
  });

  // FS-2: Orphaned .tmp files cleaned on startup
  test("cleans orphaned .tmp files on startup", async () => {
    // Create orphaned temp files
    await writeFile(join(testDir, "task_1.json.12345.abc123.tmp"), "orphan");
    await writeFile(join(testDir, "task_2.json.99999.xyz789.tmp"), "orphan");
    // Create a valid task file
    await writeFile(join(testDir, "task_1.json"), JSON.stringify(createTestTask("task_1")));

    await createFileTaskBoardStore({ baseDir: testDir });

    const files = await readdir(testDir);
    const tmpFiles = files.filter((f) => f.endsWith(".tmp"));
    expect(tmpFiles).toHaveLength(0);
    // Valid task file should still exist
    expect(files).toContain("task_1.json");
  });

  // FS-3: Orphaned .tmp cleanup can be disabled
  test("preserves .tmp files when cleanOrphanedTmp is false", async () => {
    await writeFile(join(testDir, "task_1.json.12345.abc.tmp"), "orphan");

    await createFileTaskBoardStore({ baseDir: testDir, cleanOrphanedTmp: false });

    const files = await readdir(testDir);
    expect(files.filter((f) => f.endsWith(".tmp"))).toHaveLength(1);
  });

  // FS-4: Directory doesn't exist on startup — creates it
  test("creates baseDir if it does not exist", async () => {
    const newDir = join(testDir, "deep", "nested", "tasks");
    const store = await createFileTaskBoardStore({ baseDir: newDir });

    const id = await store.nextId();
    await store.put(createTestTask(id));

    // Should have written a file
    const files = await readdir(newDir);
    expect(files).toContain(`${id}.json`);
  });

  // FS-5: Data survives process restart (write → new store → read)
  test("tasks survive store recreation", async () => {
    const store1 = await createFileTaskBoardStore({ baseDir: testDir });
    const id = await store1.nextId();
    const item = createTestTask(id, { description: "persistent task" });
    await store1.put(item);
    await store1[Symbol.asyncDispose]();

    // Create a new store instance from the same directory
    const store2 = await createFileTaskBoardStore({ baseDir: testDir });
    const loaded = await store2.get(taskItemId(id));

    expect(loaded).toEqual(item);
  });

  // FS-6: HWM survives store recreation
  test("HWM preserved across store recreation", async () => {
    const store1 = await createFileTaskBoardStore({ baseDir: testDir });
    const _id1 = await store1.nextId();
    const _id2 = await store1.nextId();
    const id3 = await store1.nextId();
    await store1.put(createTestTask(id3));
    await store1[Symbol.asyncDispose]();

    // New store should continue from HWM
    const store2 = await createFileTaskBoardStore({ baseDir: testDir });
    const id4 = await store2.nextId();

    const num3 = parseInt(id3.replace(/\D/g, ""), 10);
    const num4 = parseInt(id4.replace(/\D/g, ""), 10);
    expect(num4).toBeGreaterThan(num3);
  });

  // FS-7: Concurrent writes to different tasks don't interfere
  test("concurrent writes to different tasks succeed", async () => {
    const store = await createFileTaskBoardStore({ baseDir: testDir });
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      ids.push(await store.nextId());
    }

    // Write 5 tasks concurrently
    await Promise.all(ids.map((id) => store.put(createTestTask(id))));

    // All should be readable
    const items = await store.list();
    expect(items).toHaveLength(5);
    for (const id of ids) {
      const item = await store.get(taskItemId(id));
      expect(item).toBeDefined();
    }
  });

  // FS-8: HWM correct when store starts from directory with gaps
  test("HWM correct with gaps in IDs", async () => {
    // Manually write task files with gaps: 1, 5, 9
    await writeFile(join(testDir, "task_1.json"), JSON.stringify(createTestTask("task_1")));
    await writeFile(join(testDir, "task_5.json"), JSON.stringify(createTestTask("task_5")));
    await writeFile(join(testDir, "task_9.json"), JSON.stringify(createTestTask("task_9")));

    const store = await createFileTaskBoardStore({ baseDir: testDir });
    const next = await store.nextId();

    // HWM should be 9, so next ID should be 10
    expect(next).toBe(taskItemId("task_10"));
  });

  // FS-9: CAS enforced even with cold cache (Codex finding)
  test("rejects stale write before cache is populated", async () => {
    // Write a version-1 task file before creating the store
    const task = createTestTask("task_1", { version: 1 });
    await writeFile(join(testDir, "task_1.json"), JSON.stringify(task));

    // Create store — cache is cold (lazy), only filenames scanned
    const store = await createFileTaskBoardStore({ baseDir: testDir });

    // Attempt to write version 0 (older) immediately — before any get()/list()
    let threw = false;
    try {
      await store.put(createTestTask("task_1", { version: 0 }));
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);

    // Verify the on-disk version is still 1
    const loaded = await store.get(taskItemId("task_1"));
    expect(loaded?.version).toBe(1);
  });

  // FS-10: Missing file after known-IDs says it exists (self-healing)
  test("self-heals when known ID has no backing file", async () => {
    // Create a valid file
    await writeFile(join(testDir, "task_1.json"), JSON.stringify(createTestTask("task_1")));

    const store = await createFileTaskBoardStore({ baseDir: testDir });

    // Manually delete the file behind the store's back
    const { unlink } = await import("node:fs/promises");
    await unlink(join(testDir, "task_1.json"));

    // get() should return undefined (self-heal) instead of throwing
    const result = await store.get(taskItemId("task_1"));
    expect(result).toBeUndefined();
  });
});
