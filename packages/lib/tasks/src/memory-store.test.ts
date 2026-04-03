import { describe, expect, test } from "bun:test";
import { createMemoryTaskBoardStore } from "./memory-store.js";
import { runTaskBoardStoreContract } from "./task-board-store.contract.js";

// ---------------------------------------------------------------------------
// Contract tests
// ---------------------------------------------------------------------------

runTaskBoardStoreContract(() => createMemoryTaskBoardStore());

// ---------------------------------------------------------------------------
// Memory-specific edge cases
// ---------------------------------------------------------------------------

describe("createMemoryTaskBoardStore — memory-specific", () => {
  test("dispose clears all items", async () => {
    const store = createMemoryTaskBoardStore();
    const id = await store.nextId();
    await store.put({
      id,
      subject: "test",
      description: "test",
      dependencies: [],
      retries: 0,
      status: "pending",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    await store[Symbol.asyncDispose]();

    // Store is cleared after dispose
    expect(await store.get(id)).toBeUndefined();
  });

  test("all operations return synchronous values", async () => {
    const store = createMemoryTaskBoardStore();
    const id = await store.nextId();

    // nextId returns plain string
    expect(typeof id).toBe("string");
    // Verify it's not a Promise at runtime
    expect(store.nextId() instanceof Promise).toBe(false);

    await store.put({
      id,
      subject: "test",
      description: "test",
      dependencies: [],
      retries: 0,
      status: "pending",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const item = await store.get(id);
    expect(item?.id).toBe(id);

    const items = await store.list();
    expect(Array.isArray(items)).toBe(true);
  });
});
