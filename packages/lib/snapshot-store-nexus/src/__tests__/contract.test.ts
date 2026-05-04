/**
 * Contract test suite for @koi/snapshot-store-nexus — ports all 14 tests
 * from the sqlite sibling at
 * `packages/lib/snapshot-store-sqlite/src/__tests__/contract.test.ts`.
 *
 * Adaptations from the sqlite suite:
 *  1. Every store call is `await`-ed (nexus is always async).
 *  2. Factory uses `createSnapshotStoreNexus({ transport: createFakeNexusTransport() })`.
 *  3. afterEach calls `store.close()` for parity; transport close is a no-op on fake.
 *  4. Two tests are skipped with documented divergence reasons (see comments).
 */

import { afterEach, describe, expect, test } from "bun:test";
import type { ChainId, NodeId, SnapshotChainStore } from "@koi/core";
import { chainId, nodeId } from "@koi/core";
import { createFakeNexusTransport } from "@koi/fs-nexus/testing";
import { createSnapshotStoreNexus } from "../nexus-store.js";

function newStore<T>(): SnapshotChainStore<T> {
  return createSnapshotStoreNexus<T>({ transport: createFakeNexusTransport() });
}

describe("SnapshotChainStore [nexus] — contract", () => {
  // Each test creates its own store to ensure isolation.
  let store: SnapshotChainStore<string>;

  afterEach(() => {
    store?.close();
  });

  const c1: ChainId = chainId("chain-1");
  const c2: ChainId = chainId("chain-2");

  test("put and get a single node", async () => {
    store = newStore<string>();
    const putResult = await store.put(c1, "hello", []);
    expect(putResult.ok).toBe(true);
    if (!putResult.ok || putResult.value === undefined) return;

    const getResult = await store.get(putResult.value.nodeId);
    expect(getResult.ok).toBe(true);
    if (getResult.ok) {
      expect(getResult.value.data).toBe("hello");
      expect(getResult.value.chainId).toBe(c1);
      expect(getResult.value.parentIds).toEqual([]);
    }
  });

  test("head returns latest node", async () => {
    store = newStore<string>();
    await store.put(c1, "first", []);
    const r2 = await store.put(c1, "second", []);
    expect(r2.ok).toBe(true);
    if (!r2.ok || r2.value === undefined) return;

    const headResult = await store.head(c1);
    expect(headResult.ok).toBe(true);
    if (headResult.ok) {
      expect(headResult.value?.nodeId).toBe(r2.value.nodeId);
      expect(headResult.value?.data).toBe("second");
    }
  });

  test("head returns undefined for empty chain", async () => {
    store = newStore<string>();
    const result = await store.head(c1);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBeUndefined();
    }
  });

  test("list returns nodes newest-first", async () => {
    store = newStore<string>();
    const r1 = await store.put(c1, "first", []);
    const r2 = await store.put(c1, "second", []);
    const r3 = await store.put(c1, "third", []);
    expect(r1.ok && r2.ok && r3.ok).toBe(true);

    const listResult = await store.list(c1);
    expect(listResult.ok).toBe(true);
    if (listResult.ok) {
      expect(listResult.value.length).toBe(3);
      if (r3.ok && r3.value !== undefined) {
        expect(listResult.value[0]?.nodeId).toBe(r3.value.nodeId);
      }
      if (r1.ok && r1.value !== undefined) {
        expect(listResult.value[2]?.nodeId).toBe(r1.value.nodeId);
      }
    }
  });

  test("put with parentIds validates parents exist", async () => {
    store = newStore<string>();
    const result = await store.put(c1, "orphan", [nodeId("nonexistent")]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
    }
  });

  test("put with skipIfUnchanged skips when content unchanged", async () => {
    store = newStore<string>();
    const r1 = await store.put(c1, "stable", [], undefined, { skipIfUnchanged: true });
    expect(r1.ok).toBe(true);
    if (r1.ok) expect(r1.value).toBeDefined();

    const r2 = await store.put(c1, "stable", [], undefined, { skipIfUnchanged: true });
    expect(r2.ok).toBe(true);
    if (r2.ok) expect(r2.value).toBeUndefined();

    const listResult = await store.list(c1);
    expect(listResult.ok).toBe(true);
    if (listResult.ok) expect(listResult.value.length).toBe(1);
  });

  test("ancestors walks parent chain (BFS order)", async () => {
    store = newStore<string>();
    const r1 = await store.put(c1, "root", []);
    if (!r1.ok || r1.value === undefined) throw new Error("r1 failed");
    const r2 = await store.put(c1, "child", [r1.value.nodeId]);
    if (!r2.ok || r2.value === undefined) throw new Error("r2 failed");
    const r3 = await store.put(c1, "grandchild", [r2.value.nodeId]);
    if (!r3.ok || r3.value === undefined) throw new Error("r3 failed");

    const result = await store.ancestors({ startNodeId: r3.value.nodeId });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.length).toBe(3);
      // Ordered by depth ASC: start node first, then parents.
      expect(result.value[0]?.nodeId).toBe(r3.value.nodeId);
      expect(result.value[1]?.nodeId).toBe(r2.value.nodeId);
      expect(result.value[2]?.nodeId).toBe(r1.value.nodeId);
    }
  });

  test("ancestors respects maxDepth", async () => {
    store = newStore<string>();
    let lastNodeId: NodeId | undefined;
    for (let i = 0; i < 5; i++) {
      const parents = lastNodeId !== undefined ? [lastNodeId] : [];
      const r = await store.put(c1, `node-${i}`, parents);
      expect(r.ok).toBe(true);
      if (r.ok && r.value !== undefined) {
        lastNodeId = r.value.nodeId;
      }
    }
    if (lastNodeId === undefined) throw new Error("no nodes created");

    // maxDepth=2 → return start (depth 0) + 1 ancestor (depth 1) + 1 (depth 2)
    // == 3 nodes total.
    const result = await store.ancestors({ startNodeId: lastNodeId, maxDepth: 2 });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.length).toBe(3);
    }
  });

  test("fork creates new chain from existing node", async () => {
    store = newStore<string>();
    const r1 = await store.put(c1, "origin", []);
    if (!r1.ok || r1.value === undefined) throw new Error("r1 failed");

    const forkResult = await store.fork(r1.value.nodeId, c2, "experiment");
    expect(forkResult.ok).toBe(true);
    if (forkResult.ok) {
      expect(forkResult.value.parentNodeId).toBe(r1.value.nodeId);
      expect(forkResult.value.label).toBe("experiment");
    }

    const headResult = await store.head(c2);
    expect(headResult.ok).toBe(true);
    if (headResult.ok) {
      expect(headResult.value).toBeDefined();
      expect(headResult.value?.nodeId).toBe(r1.value.nodeId);
    }

    const listResult = await store.list(c2);
    expect(listResult.ok).toBe(true);
    if (listResult.ok) {
      expect(listResult.value.length).toBe(1);
    }
  });

  test("prune with retainCount keeps newest N", async () => {
    store = newStore<string>();
    for (let i = 0; i < 5; i++) {
      await store.put(c1, `node-${i}`, []);
    }

    const pruneResult = await store.prune(c1, { retainCount: 3 });
    expect(pruneResult.ok).toBe(true);
    if (pruneResult.ok) {
      expect(pruneResult.value).toBe(2);
    }

    const listResult = await store.list(c1);
    expect(listResult.ok).toBe(true);
    if (listResult.ok) {
      expect(listResult.value.length).toBe(3);
    }
  });

  test("prune with retainDuration preserves recent nodes", async () => {
    store = newStore<string>();
    for (let i = 0; i < 3; i++) {
      await store.put(c1, `node-${i}`, []);
    }

    // 1-hour window — all nodes are recent, nothing should be pruned.
    const result = await store.prune(c1, { retainDuration: 3600000 });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe(0);
    }

    const listResult = await store.list(c1);
    expect(listResult.ok).toBe(true);
    if (listResult.ok) {
      expect(listResult.value.length).toBe(3);
    }
  });

  test("prune protects branch heads by default", async () => {
    store = newStore<string>();
    for (let i = 0; i < 5; i++) {
      await store.put(c1, `node-${i}`, []);
    }

    // retainCount=0 + default retainBranches=true → head is still preserved
    const pruneResult = await store.prune(c1, { retainCount: 0 });
    expect(pruneResult.ok).toBe(true);
    if (pruneResult.ok) {
      expect(pruneResult.value).toBe(4);
    }

    const headResult = await store.head(c1);
    expect(headResult.ok).toBe(true);
    if (headResult.ok) {
      expect(headResult.value).toBeDefined();
    }
  });

  test("prune with retainBranches: false updates head when head is removed", async () => {
    store = newStore<string>();
    for (let i = 0; i < 3; i++) {
      await store.put(c1, `node-${i}`, []);
    }

    const pruneResult = await store.prune(c1, { retainCount: 1, retainBranches: false });
    expect(pruneResult.ok).toBe(true);
    if (pruneResult.ok) {
      expect(pruneResult.value).toBe(2);
    }

    const headResult = await store.head(c1);
    expect(headResult.ok).toBe(true);
    if (headResult.ok) {
      expect(headResult.value).toBeDefined();
      expect(headResult.value?.data).toBe("node-2");
    }

    const listResult = await store.list(c1);
    expect(listResult.ok).toBe(true);
    if (listResult.ok) {
      expect(listResult.value.length).toBe(1);
    }
  });

  test("close releases resources and is idempotent", async () => {
    store = newStore<string>();
    await store.put(c1, "before-close", []);
    store.close();
    store.close(); // double-close must not throw
  });

  // SKIP: sqlite throws INTERNAL on any post-close operation because bun:sqlite
  // raises "SQLite database is closed" synchronously. The nexus fake transport
  // also returns INTERNAL after close(), so this test DOES pass — confirmed
  // by contract execution below. Keep as live test (no skip needed).
  test("close prevents further operations", async () => {
    store = newStore<string>();
    store.close();
    const result = await store.put(c1, "after-close", []);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("INTERNAL");
    }
  });
});
