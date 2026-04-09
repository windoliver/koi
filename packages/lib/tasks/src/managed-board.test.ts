/**
 * ManagedTaskBoard tests — verifies board↔store bridge behavior.
 */

import { describe, expect, test } from "bun:test";
import { mkdir, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { KoiError, TaskResult } from "@koi/core";
import { taskItemId } from "@koi/core";
import { createManagedTaskBoard } from "./managed-board.js";
import { createMemoryTaskBoardStore } from "./memory-store.js";

function agentId(id: string): import("@koi/core").AgentId {
  return id as import("@koi/core").AgentId;
}

function result(id: string): TaskResult {
  return { taskId: taskItemId(id), output: "done", durationMs: 100 };
}

let dirCounter = 0;
async function freshDir(): Promise<string> {
  dirCounter += 1;
  const dir = join(tmpdir(), `koi-managed-test-${Date.now()}-${dirCounter}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

describe("createManagedTaskBoard", () => {
  test("loads initial state from store", async () => {
    const store = createMemoryTaskBoardStore();
    const id = await store.nextId();
    await store.put({
      id,
      subject: "pre-existing",
      description: "pre-existing",
      dependencies: [],
      retries: 0,
      version: 0,
      status: "pending",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const managed = await createManagedTaskBoard({ store });
    expect(managed.snapshot().size()).toBe(1);
    expect(managed.snapshot().get(id)?.subject).toBe("pre-existing");
  });

  test("add persists to store", async () => {
    const store = createMemoryTaskBoardStore();
    const managed = await createManagedTaskBoard({ store });

    const r = await managed.add({
      id: taskItemId("task_1"),
      description: "test task",
    });
    expect(r.ok).toBe(true);

    // Verify it's in the store
    const stored = await store.get(taskItemId("task_1"));
    expect(stored).toBeDefined();
    expect(stored?.description).toBe("test task");
  });

  test("assign persists updated task to store", async () => {
    const store = createMemoryTaskBoardStore();
    const managed = await createManagedTaskBoard({ store });

    await managed.add({ id: taskItemId("task_1"), description: "test" });
    const r = await managed.assign(taskItemId("task_1"), agentId("w1"));
    expect(r.ok).toBe(true);

    const stored = await store.get(taskItemId("task_1"));
    expect(stored?.status).toBe("in_progress");
    expect(stored?.assignedTo).toBe(agentId("w1"));
    expect(stored?.version).toBe(1);
  });

  test("complete persists to store", async () => {
    const store = createMemoryTaskBoardStore();
    const managed = await createManagedTaskBoard({ store });

    await managed.add({ id: taskItemId("task_1"), description: "test" });
    await managed.assign(taskItemId("task_1"), agentId("w1"));
    const r = await managed.complete(taskItemId("task_1"), result("task_1"));
    expect(r.ok).toBe(true);

    const stored = await store.get(taskItemId("task_1"));
    expect(stored?.status).toBe("completed");
  });

  test("fail with retry persists back to pending", async () => {
    const store = createMemoryTaskBoardStore();
    const managed = await createManagedTaskBoard({
      store,
      boardConfig: { maxRetries: 3 },
    });

    await managed.add({ id: taskItemId("task_1"), description: "test" });
    await managed.assign(taskItemId("task_1"), agentId("w1"));
    const err: KoiError = { code: "EXTERNAL", message: "timeout", retryable: true };
    const r = await managed.fail(taskItemId("task_1"), err);
    expect(r.ok).toBe(true);

    const stored = await store.get(taskItemId("task_1"));
    expect(stored?.status).toBe("pending");
    expect(stored?.retries).toBe(1);
  });

  test("kill persists to store", async () => {
    const store = createMemoryTaskBoardStore();
    const managed = await createManagedTaskBoard({ store });

    await managed.add({ id: taskItemId("task_1"), description: "test" });
    const r = await managed.kill(taskItemId("task_1"));
    expect(r.ok).toBe(true);

    const stored = await store.get(taskItemId("task_1"));
    expect(stored?.status).toBe("killed");
  });

  test("validation errors do not persist", async () => {
    const store = createMemoryTaskBoardStore();
    const managed = await createManagedTaskBoard({ store });

    // Try to assign a non-existent task
    const r = await managed.assign(taskItemId("nope"), agentId("w1"));
    expect(r.ok).toBe(false);

    // Store should be empty
    expect(await store.list()).toEqual([]);
  });

  test("snapshot reflects current board state", async () => {
    const store = createMemoryTaskBoardStore();
    const managed = await createManagedTaskBoard({ store });

    await managed.add({ id: taskItemId("a"), description: "first" });
    expect(managed.snapshot().size()).toBe(1);

    await managed.add({ id: taskItemId("b"), description: "second" });
    expect(managed.snapshot().size()).toBe(2);
  });

  test("addAll persists all tasks to store", async () => {
    const store = createMemoryTaskBoardStore();
    const managed = await createManagedTaskBoard({ store });

    const r = await managed.addAll([
      { id: taskItemId("a"), description: "first" },
      { id: taskItemId("b"), description: "second", dependencies: [taskItemId("a")] },
    ]);
    expect(r.ok).toBe(true);

    const items = await store.list();
    expect(items).toHaveLength(2);
  });

  // ---------------------------------------------------------------------------
  // Fix 1: Mutation serialization (Codex finding: concurrent call race)
  // ---------------------------------------------------------------------------

  test("concurrent mutations are serialized — second sees first's result", async () => {
    const store = createMemoryTaskBoardStore();
    const managed = await createManagedTaskBoard({ store });

    await managed.add({ id: taskItemId("a"), description: "test" });
    await managed.add({ id: taskItemId("b"), description: "test" });

    // Fire two assign() calls concurrently on different tasks
    const [r1, r2] = await Promise.all([
      managed.assign(taskItemId("a"), agentId("w1")),
      managed.assign(taskItemId("b"), agentId("w2")),
    ]);

    // Both should succeed — the mutex ensures sequential execution
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);

    // Both tasks should be in_progress with correct agents
    const a = await store.get(taskItemId("a"));
    const b = await store.get(taskItemId("b"));
    expect(a?.status).toBe("in_progress");
    expect(a?.assignedTo).toBe(agentId("w1"));
    expect(b?.status).toBe("in_progress");
    expect(b?.assignedTo).toBe(agentId("w2"));
  });

  test("concurrent mutations on same task — second sees first's version", async () => {
    const store = createMemoryTaskBoardStore();
    const managed = await createManagedTaskBoard({
      store,
      boardConfig: { maxInProgressPerOwner: 1 },
    });

    await managed.add({ id: taskItemId("a"), description: "test" });
    await managed.add({ id: taskItemId("b"), description: "test" });

    // Assign both to same agent concurrently with limit=1
    // Second should fail because first completes first (serialized)
    const [r1, r2] = await Promise.all([
      managed.assign(taskItemId("a"), agentId("w1")),
      managed.assign(taskItemId("b"), agentId("w1")),
    ]);

    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(false);
    if (!r2.ok) {
      expect(r2.error.code).toBe("VALIDATION");
    }
  });

  // ---------------------------------------------------------------------------
  // Fix 3: TaskResult persistence via resultsDir
  // ---------------------------------------------------------------------------

  test("persists TaskResult to resultsDir on complete", async () => {
    const store = createMemoryTaskBoardStore();
    const dir = await freshDir();
    const managed = await createManagedTaskBoard({ store, resultsDir: dir });

    await managed.add({ id: taskItemId("task_1"), description: "test" });
    await managed.assign(taskItemId("task_1"), agentId("w1"));
    await managed.complete(taskItemId("task_1"), result("task_1"));

    // Verify result file exists
    const files = await readdir(dir);
    expect(files).toContain("task_1.result.json");
  });

  test("loads persisted results on construction — board.result() works after restart", async () => {
    const store = createMemoryTaskBoardStore();
    const dir = await freshDir();

    // First session: add, assign, complete
    const managed1 = await createManagedTaskBoard({ store, resultsDir: dir });
    await managed1.add({ id: taskItemId("task_1"), description: "test" });
    await managed1.assign(taskItemId("task_1"), agentId("w1"));
    await managed1.complete(taskItemId("task_1"), {
      taskId: taskItemId("task_1"),
      output: "important output",
      durationMs: 200,
    });

    // Simulate restart: create a new managed board from same store + resultsDir
    const managed2 = await createManagedTaskBoard({ store, resultsDir: dir });

    // board.result() should return the persisted result
    const r = managed2.snapshot().result(taskItemId("task_1"));
    expect(r).toBeDefined();
    expect(r?.output).toBe("important output");
    expect(managed2.snapshot().completed()).toHaveLength(1);
  });

  test("without resultsDir, results are in-memory only", async () => {
    const store = createMemoryTaskBoardStore();
    const managed = await createManagedTaskBoard({ store });

    await managed.add({ id: taskItemId("task_1"), description: "test" });
    await managed.assign(taskItemId("task_1"), agentId("w1"));
    await managed.complete(taskItemId("task_1"), result("task_1"));

    // Result is available in current session
    expect(managed.snapshot().result(taskItemId("task_1"))).toBeDefined();

    // But a new managed board won't have results (no resultsDir)
    const managed2 = await createManagedTaskBoard({ store });
    expect(managed2.snapshot().result(taskItemId("task_1"))).toBeUndefined();
  });
});

describe("nextId", () => {
  test("returns a valid TaskItemId", async () => {
    const store = createMemoryTaskBoardStore();
    const managed = await createManagedTaskBoard({ store });
    const id = await managed.nextId();
    expect(typeof id).toBe("string");
    expect(id.length).toBeGreaterThan(0);
  });

  test("consecutive calls return distinct IDs", async () => {
    const store = createMemoryTaskBoardStore();
    const managed = await createManagedTaskBoard({ store });
    const id1 = await managed.nextId();
    const id2 = await managed.nextId();
    const id3 = await managed.nextId();
    expect(id1).not.toBe(id2);
    expect(id2).not.toBe(id3);
    expect(id1).not.toBe(id3);
  });

  test("ID returned by nextId() is usable in add() without conflict", async () => {
    const store = createMemoryTaskBoardStore();
    const managed = await createManagedTaskBoard({ store });
    const id = await managed.nextId();
    const r = await managed.add({ id, description: "Test task" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.get(id)).toBeDefined();
  });
});
