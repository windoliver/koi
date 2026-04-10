/**
 * TaskBoardStore contract test suite.
 *
 * Any implementation of TaskBoardStore must pass these tests.
 * Usage:
 *   runTaskBoardStoreContract(() => createMyStore());
 *
 * Exported from @koi/tasks so future store implementations
 * (e.g., Nexus-backed) can reuse the same behavioral contract.
 */

import { describe, expect, it, mock } from "bun:test";
import type { Task, TaskBoardStore, TaskBoardStoreEvent, TaskItemId } from "@koi/core";
import { agentId, taskItemId } from "@koi/core";

/** Helper: create a minimal Task for testing. */
function createTestTask(overrides: Partial<Task> & { readonly id: TaskItemId }): Task {
  return {
    subject: `Task ${overrides.id}`,
    description: `Task ${overrides.id}`,
    dependencies: [],
    retries: 0,
    version: 0,
    status: "pending",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

/**
 * Run the full TaskBoardStore behavioral contract against a factory.
 *
 * @param factory — Creates a fresh store for each test. May return a promise.
 * @param suiteName — Optional name prefix for the describe block.
 */
export function runTaskBoardStoreContract(
  factory: () => TaskBoardStore | Promise<TaskBoardStore>,
  suiteName = "TaskBoardStore contract",
): void {
  // -------------------------------------------------------------------------
  // CRUD basics
  // -------------------------------------------------------------------------

  describe(`${suiteName} — CRUD`, () => {
    it("round-trips: put then get returns the item", async () => {
      const store = await factory();
      const id = await store.nextId();
      const item = createTestTask({ id });

      await store.put(item);
      const loaded = await store.get(id);

      expect(loaded).toEqual(item);
    });

    it("get returns undefined for unknown ID", async () => {
      const store = await factory();
      // Use a canonical task_<N> ID — some backends (file store) validate the
      // shape at the I/O boundary. The semantic being tested is "no such task
      // exists", not "malformed ID".
      const result = await store.get(taskItemId("task_999999"));
      expect(result).toBeUndefined();
    });

    it("put overwrites existing item when version is incremented", async () => {
      const store = await factory();
      const id = await store.nextId();

      await store.put(createTestTask({ id, description: "v1", version: 0 }));
      await store.put(createTestTask({ id, description: "v2", version: 1 }));

      const loaded = await store.get(id);
      expect(loaded?.description).toBe("v2");
    });

    it("delete removes the item", async () => {
      const store = await factory();
      const id = await store.nextId();
      await store.put(createTestTask({ id }));

      await store.delete(id);

      expect(await store.get(id)).toBeUndefined();
    });

    it("delete is a no-op for unknown ID", async () => {
      const store = await factory();
      // Should not throw (canonical task_<N> shape passes file store guard)
      await store.delete(taskItemId("task_999999"));
    });

    it("list returns all items when no filter is provided", async () => {
      const store = await factory();
      const id1 = await store.nextId();
      const id2 = await store.nextId();
      await store.put(createTestTask({ id: id1 }));
      await store.put(createTestTask({ id: id2 }));

      const items = await store.list();
      expect(items).toHaveLength(2);
      const ids = items.map((i) => i.id);
      expect(ids).toContain(id1);
      expect(ids).toContain(id2);
    });

    it("list returns empty array for empty store", async () => {
      const store = await factory();
      expect(await store.list()).toEqual([]);
    });

    it("preserves all Task fields through round-trip", async () => {
      const store = await factory();
      const id = await store.nextId();
      const now = Date.now();
      const item: Task = {
        id,
        subject: "Full task test",
        description: "full task test with all fields",
        dependencies: [taskItemId("task_dep_1"), taskItemId("task_dep_2")],
        retries: 2,
        version: 0,
        status: "in_progress",
        assignedTo: agentId("agent_1"),
        metadata: { key: "value" },
        createdAt: now,
        updatedAt: now,
      };

      await store.put(item);
      const loaded = await store.get(id);

      expect(loaded).toEqual(item);
    });
  });

  // -------------------------------------------------------------------------
  // List filtering
  // -------------------------------------------------------------------------

  describe(`${suiteName} — list filters`, () => {
    it("filters by status", async () => {
      const store = await factory();
      const id1 = await store.nextId();
      const id2 = await store.nextId();
      const id3 = await store.nextId();
      await store.put(createTestTask({ id: id1, status: "pending" }));
      await store.put(createTestTask({ id: id2, status: "completed" }));
      await store.put(createTestTask({ id: id3, status: "pending" }));

      const pending = await store.list({ status: "pending" });
      expect(pending).toHaveLength(2);
      expect(pending.map((i) => i.id)).toContain(id1);
      expect(pending.map((i) => i.id)).toContain(id3);
    });

    it("filters by assignedTo", async () => {
      const store = await factory();
      const id1 = await store.nextId();
      const id2 = await store.nextId();
      const agent = agentId("agent_1");
      await store.put(createTestTask({ id: id1, assignedTo: agent }));
      await store.put(createTestTask({ id: id2 }));

      const assigned = await store.list({ assignedTo: agent });
      expect(assigned).toHaveLength(1);
      expect(assigned[0]?.id).toBe(id1);
    });

    it("filters by status AND assignedTo", async () => {
      const store = await factory();
      const id1 = await store.nextId();
      const id2 = await store.nextId();
      const id3 = await store.nextId();
      const agent = agentId("agent_1");
      await store.put(createTestTask({ id: id1, status: "in_progress", assignedTo: agent }));
      await store.put(createTestTask({ id: id2, status: "pending", assignedTo: agent }));
      await store.put(createTestTask({ id: id3, status: "in_progress" }));

      const result = await store.list({ status: "in_progress", assignedTo: agent });
      expect(result).toHaveLength(1);
      expect(result[0]?.id).toBe(id1);
    });
  });

  // -------------------------------------------------------------------------
  // ID generation + high water mark
  // -------------------------------------------------------------------------

  describe(`${suiteName} — ID generation + HWM`, () => {
    it("generates monotonically increasing IDs", async () => {
      const store = await factory();
      const id1 = await store.nextId();
      const id2 = await store.nextId();
      const id3 = await store.nextId();

      // Extract numeric parts and verify ordering
      const num1 = parseInt(id1.replace(/\D/g, ""), 10);
      const num2 = parseInt(id2.replace(/\D/g, ""), 10);
      const num3 = parseInt(id3.replace(/\D/g, ""), 10);

      expect(num2).toBeGreaterThan(num1);
      expect(num3).toBeGreaterThan(num2);
    });

    it("IDs never reuse after delete + create cycle", async () => {
      const store = await factory();
      const id1 = await store.nextId();
      const id2 = await store.nextId();
      await store.put(createTestTask({ id: id1 }));
      await store.put(createTestTask({ id: id2 }));

      // Delete both
      await store.delete(id1);
      await store.delete(id2);

      // New IDs must be higher
      const id3 = await store.nextId();
      const num2 = parseInt(id2.replace(/\D/g, ""), 10);
      const num3 = parseInt(id3.replace(/\D/g, ""), 10);
      expect(num3).toBeGreaterThan(num2);
    });

    it("HWM preserved after deleting the highest-ID task", async () => {
      const store = await factory();
      const _id1 = await store.nextId();
      const _id2 = await store.nextId();
      const id3 = await store.nextId();
      await store.put(createTestTask({ id: id3 }));

      // Delete the highest ID
      await store.delete(id3);

      // Next ID must be higher than id3
      const id4 = await store.nextId();
      const num3 = parseInt(id3.replace(/\D/g, ""), 10);
      const num4 = parseInt(id4.replace(/\D/g, ""), 10);
      expect(num4).toBeGreaterThan(num3);
    });

    it("HWM preserved after reset", async () => {
      const store = await factory();
      const id1 = await store.nextId();
      const id2 = await store.nextId();
      await store.put(createTestTask({ id: id1 }));
      await store.put(createTestTask({ id: id2 }));

      await store.reset();

      // Store should be empty
      expect(await store.list()).toEqual([]);

      // But next ID is still higher
      const id3 = await store.nextId();
      const num2 = parseInt(id2.replace(/\D/g, ""), 10);
      const num3 = parseInt(id3.replace(/\D/g, ""), 10);
      expect(num3).toBeGreaterThan(num2);
    });

    it("HWM correct when IDs have gaps", async () => {
      const store = await factory();

      // Generate 3 IDs but only persist the first and third
      const id1 = await store.nextId();
      const _id2 = await store.nextId();
      const id3 = await store.nextId();
      await store.put(createTestTask({ id: id1 }));
      await store.put(createTestTask({ id: id3 }));

      // Next ID must be after id3 (the highest generated, regardless of what's stored)
      const id4 = await store.nextId();
      const num3 = parseInt(id3.replace(/\D/g, ""), 10);
      const num4 = parseInt(id4.replace(/\D/g, ""), 10);
      expect(num4).toBeGreaterThan(num3);
    });
  });

  // -------------------------------------------------------------------------
  // Watch
  // -------------------------------------------------------------------------

  describe(`${suiteName} — watch`, () => {
    it("fires put event on store.put()", async () => {
      const store = await factory();
      const events: TaskBoardStoreEvent[] = [];
      store.watch((e) => events.push(e));

      const id = await store.nextId();
      const item = createTestTask({ id });
      await store.put(item);

      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({ kind: "put", item });
    });

    it("fires deleted event on store.delete()", async () => {
      const store = await factory();
      const id = await store.nextId();
      await store.put(createTestTask({ id }));

      const events: TaskBoardStoreEvent[] = [];
      store.watch((e) => events.push(e));

      await store.delete(id);

      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({ kind: "deleted", id });
    });

    it("unsubscribe stops notifications", async () => {
      const store = await factory();
      const events: TaskBoardStoreEvent[] = [];
      const unsub = store.watch((e) => events.push(e));

      const id1 = await store.nextId();
      await store.put(createTestTask({ id: id1 }));

      unsub();

      const id2 = await store.nextId();
      await store.put(createTestTask({ id: id2 }));

      expect(events).toHaveLength(1);
    });

    it("delete of nonexistent ID does not fire event", async () => {
      const store = await factory();
      const listener = mock(() => undefined);
      store.watch(listener);

      await store.delete(taskItemId("task_999999"));

      expect(listener).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Reset
  // -------------------------------------------------------------------------

  describe(`${suiteName} — reset`, () => {
    it("clears all items", async () => {
      const store = await factory();
      const id1 = await store.nextId();
      const id2 = await store.nextId();
      await store.put(createTestTask({ id: id1 }));
      await store.put(createTestTask({ id: id2 }));

      await store.reset();

      expect(await store.list()).toEqual([]);
      expect(await store.get(id1)).toBeUndefined();
      expect(await store.get(id2)).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // Dispose
  // -------------------------------------------------------------------------

  describe(`${suiteName} — dispose`, () => {
    it("get returns undefined after dispose", async () => {
      const store = await factory();
      const id = await store.nextId();
      await store.put(createTestTask({ id }));

      await store[Symbol.asyncDispose]();

      expect(await store.get(id)).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // Version-based CAS
  // -------------------------------------------------------------------------

  describe(`${suiteName} — version CAS`, () => {
    it("rejects put with older version than stored", async () => {
      const store = await factory();
      const id = await store.nextId();

      // Write version 1
      await store.put(createTestTask({ id, version: 1 }));

      // Attempt to write version 0 (older) — should throw
      let threw = false;
      try {
        await store.put(createTestTask({ id, version: 0 }));
      } catch {
        threw = true;
      }
      expect(threw).toBe(true);

      // Stored item should still be version 1
      const stored = await store.get(id);
      expect(stored?.version).toBe(1);
    });

    it("accepts put with higher version", async () => {
      const store = await factory();
      const id = await store.nextId();

      await store.put(createTestTask({ id, version: 0 }));
      await store.put(createTestTask({ id, version: 1, description: "updated" }));

      const stored = await store.get(id);
      expect(stored?.version).toBe(1);
      expect(stored?.description).toBe("updated");
    });

    it("rejects put with same version as stored (prevents concurrent overwrites)", async () => {
      const store = await factory();
      const id = await store.nextId();

      await store.put(createTestTask({ id, version: 1 }));

      // Same version = stale write from a concurrent writer
      let threw = false;
      try {
        await store.put(createTestTask({ id, version: 1, description: "stale" }));
      } catch {
        threw = true;
      }
      expect(threw).toBe(true);

      // Stored item should be unchanged
      const stored = await store.get(id);
      expect(stored?.description).toBe(`Task ${id}`);
    });

    it("sequential version increments succeed", async () => {
      const store = await factory();
      const id = await store.nextId();

      await store.put(createTestTask({ id, version: 0 }));
      await store.put(createTestTask({ id, version: 1, description: "v1" }));
      await store.put(createTestTask({ id, version: 2, description: "v2" }));

      const stored = await store.get(id);
      expect(stored?.version).toBe(2);
      expect(stored?.description).toBe("v2");
    });
  });
}
