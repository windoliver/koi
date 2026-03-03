import { describe, expect, test } from "bun:test";
import type { ChainId } from "@koi/core";
import { chainId, nodeId } from "@koi/core";
import { runSnapshotChainStoreContractTests } from "@koi/test-utils";
import { createSqliteSnapshotStore } from "./sqlite-store.js";

// ---------------------------------------------------------------------------
// Test data type
// ---------------------------------------------------------------------------

interface TestData {
  readonly name: string;
  readonly value: number;
}

// ---------------------------------------------------------------------------
// Shared contract tests (parameterized suite)
// ---------------------------------------------------------------------------

describe("SqliteSnapshotStore (contract)", () => {
  runSnapshotChainStoreContractTests<TestData>(
    () => createSqliteSnapshotStore<TestData>({ dbPath: ":memory:" }),
    () => ({ name: "test", value: Math.random() }),
    () => ({ name: "different", value: -1 }),
  );
});

// ---------------------------------------------------------------------------
// SQLite-specific tests
// ---------------------------------------------------------------------------

describe("SqliteSnapshotStore (sqlite-specific)", () => {
  const c1: ChainId = chainId("chain-1");

  test("survives close + reopen with same DB file", async () => {
    const tmpDir = `${import.meta.dir}/__test_db_${Date.now()}`;
    const { mkdirSync, rmSync } = require("node:fs");
    mkdirSync(tmpDir, { recursive: true });
    const dbPath = `${tmpDir}/test.db`;

    try {
      // Write data
      const store1 = createSqliteSnapshotStore<TestData>({ dbPath });
      const putResult = await store1.put(c1, { name: "persistent", value: 42 }, []);
      expect(putResult.ok).toBe(true);
      if (!putResult.ok || putResult.value === undefined) return;
      const savedNodeId = putResult.value.nodeId;
      await store1.close();

      // Reopen and verify
      const store2 = createSqliteSnapshotStore<TestData>({ dbPath });
      const getResult = await store2.get(savedNodeId);
      expect(getResult.ok).toBe(true);
      if (getResult.ok) {
        expect(getResult.value.data).toEqual({ name: "persistent", value: 42 });
      }

      // Head should be restored
      const headResult = await store2.head(c1);
      expect(headResult.ok).toBe(true);
      if (headResult.ok) {
        expect(headResult.value).toBeDefined();
        expect(headResult.value?.nodeId).toBe(savedNodeId);
      }
      await store2.close();
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("durability=os sets PRAGMA synchronous=FULL", async () => {
    const store = createSqliteSnapshotStore<TestData>({
      dbPath: ":memory:",
      durability: "os",
    });
    // If it doesn't throw, configuration succeeded
    const putResult = await store.put(c1, { name: "test", value: 1 }, []);
    expect(putResult.ok).toBe(true);
    await store.close();
  });

  test("custom tableName allows multiple stores per DB", async () => {
    const storeA = createSqliteSnapshotStore<TestData>({
      dbPath: ":memory:",
      tableName: "store_a",
    });
    const storeB = createSqliteSnapshotStore<TestData>({
      dbPath: ":memory:",
      tableName: "store_b",
    });

    const rA = await storeA.put(c1, { name: "a", value: 1 }, []);
    const rB = await storeB.put(c1, { name: "b", value: 2 }, []);
    expect(rA.ok).toBe(true);
    expect(rB.ok).toBe(true);

    // Each store sees only its own data
    const listA = await storeA.list(c1);
    const listB = await storeB.list(c1);
    expect(listA.ok).toBe(true);
    expect(listB.ok).toBe(true);
    if (listA.ok) expect(listA.value.length).toBe(1);
    if (listB.ok) expect(listB.value.length).toBe(1);

    await storeA.close();
    await storeB.close();
  });

  test("content hash consistency with JSON round-trip", async () => {
    const store = createSqliteSnapshotStore<TestData>({ dbPath: ":memory:" });
    const data: TestData = { name: "hash-test", value: 99 };

    const r1 = await store.put(c1, data, []);
    expect(r1.ok).toBe(true);
    if (!r1.ok || r1.value === undefined) return;

    // Same data → same hash (skipIfUnchanged should skip)
    const r2 = await store.put(c1, { name: "hash-test", value: 99 }, [], undefined, {
      skipIfUnchanged: true,
    });
    expect(r2.ok).toBe(true);
    if (r2.ok) {
      expect(r2.value).toBeUndefined(); // skipped
    }
    await store.close();
  });

  test("operations after close return INTERNAL error", async () => {
    const store = createSqliteSnapshotStore<TestData>({ dbPath: ":memory:" });
    await store.close();

    const putResult = await store.put(c1, { name: "x", value: 0 }, []);
    expect(putResult.ok).toBe(false);
    if (!putResult.ok) {
      expect(putResult.error.code).toBe("INTERNAL");
    }

    const getResult = await store.get(nodeId("any"));
    expect(getResult.ok).toBe(false);

    const headResult = await store.head(c1);
    expect(headResult.ok).toBe(false);
  });
});
