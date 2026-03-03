/**
 * Reusable contract test suite for any SnapshotChainStore<T> implementation.
 *
 * Call `runSnapshotChainStoreContractTests(createStore, createData, createDifferentData)`
 * with factories that create a fresh store and test data per test group.
 */

import { describe, expect, test } from "bun:test";
import type { ChainId, NodeId, SnapshotChainStore } from "@koi/core";
import { chainId, nodeId } from "@koi/core";

// ---------------------------------------------------------------------------
// Contract tests
// ---------------------------------------------------------------------------

export function runSnapshotChainStoreContractTests<T>(
  createStore: () => SnapshotChainStore<T> | Promise<SnapshotChainStore<T>>,
  createData: () => T,
  createDifferentData: () => T,
): void {
  const c1: ChainId = chainId("chain-1");
  const c2: ChainId = chainId("chain-2");

  // -----------------------------------------------------------------------
  // Basic CRUD
  // -----------------------------------------------------------------------
  describe("basic CRUD", () => {
    test("put and get round-trip", async () => {
      const store = await createStore();
      const data = createData();
      const putResult = await store.put(c1, data, []);
      expect(putResult.ok).toBe(true);
      if (!putResult.ok) return;
      const node = putResult.value;
      expect(node).toBeDefined();
      if (node === undefined) return;

      const getResult = await store.get(node.nodeId);
      expect(getResult.ok).toBe(true);
      if (getResult.ok) {
        expect(getResult.value.nodeId).toBe(node.nodeId);
        expect(getResult.value.chainId).toBe(c1);
        expect(getResult.value.parentIds).toEqual([]);
      }
      await store.close();
    });

    test("get returns NOT_FOUND for missing node", async () => {
      const store = await createStore();
      const result = await store.get(nodeId("nonexistent"));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("NOT_FOUND");
      }
      await store.close();
    });

    test("head returns undefined for empty chain", async () => {
      const store = await createStore();
      const result = await store.head(c1);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBeUndefined();
      }
      await store.close();
    });

    test("head returns most recent node", async () => {
      const store = await createStore();
      await store.put(c1, createData(), []);
      const putResult = await store.put(c1, createData(), []);
      expect(putResult.ok).toBe(true);
      if (!putResult.ok) return;

      const headResult = await store.head(c1);
      expect(headResult.ok).toBe(true);
      if (headResult.ok && putResult.value !== undefined) {
        expect(headResult.value?.nodeId).toBe(putResult.value.nodeId);
      }
      await store.close();
    });

    test("list returns nodes newest first", async () => {
      const store = await createStore();
      const r1 = await store.put(c1, createData(), []);
      const r2 = await store.put(c1, createData(), []);
      const r3 = await store.put(c1, createData(), []);
      expect(r1.ok && r2.ok && r3.ok).toBe(true);

      const listResult = await store.list(c1);
      expect(listResult.ok).toBe(true);
      if (listResult.ok) {
        expect(listResult.value.length).toBe(3);
        // Newest first
        if (r3.ok && r3.value !== undefined) {
          expect(listResult.value[0]?.nodeId).toBe(r3.value.nodeId);
        }
        if (r1.ok && r1.value !== undefined) {
          expect(listResult.value[2]?.nodeId).toBe(r1.value.nodeId);
        }
      }
      await store.close();
    });

    test("list returns empty array for unknown chain", async () => {
      const store = await createStore();
      const result = await store.list(c1);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.length).toBe(0);
      }
      await store.close();
    });

    test("put stores metadata", async () => {
      const store = await createStore();
      const meta = { reason: "test", actor: "agent-1" };
      const putResult = await store.put(c1, createData(), [], meta);
      expect(putResult.ok).toBe(true);
      if (!putResult.ok || putResult.value === undefined) return;

      const getResult = await store.get(putResult.value.nodeId);
      expect(getResult.ok).toBe(true);
      if (getResult.ok) {
        expect(getResult.value.metadata).toEqual(meta);
      }
      await store.close();
    });

    test("put generates unique node IDs", async () => {
      const store = await createStore();
      const r1 = await store.put(c1, createData(), []);
      const r2 = await store.put(c1, createData(), []);
      expect(r1.ok && r2.ok).toBe(true);
      if (r1.ok && r2.ok && r1.value !== undefined && r2.value !== undefined) {
        expect(r1.value.nodeId).not.toBe(r2.value.nodeId);
      }
      await store.close();
    });
  });

  // -----------------------------------------------------------------------
  // Content hash skip
  // -----------------------------------------------------------------------
  describe("content hash skip", () => {
    test("skipIfUnchanged=true skips when content matches head", async () => {
      const store = await createStore();
      const data = createData();
      const r1 = await store.put(c1, data, []);
      expect(r1.ok).toBe(true);

      // Same data, should be skipped
      const r2 = await store.put(c1, data, [], undefined, { skipIfUnchanged: true });
      expect(r2.ok).toBe(true);
      if (r2.ok) {
        expect(r2.value).toBeUndefined();
      }

      // Chain should still have only 1 node
      const listResult = await store.list(c1);
      expect(listResult.ok).toBe(true);
      if (listResult.ok) {
        expect(listResult.value.length).toBe(1);
      }
      await store.close();
    });

    test("skipIfUnchanged=true writes when content differs", async () => {
      const store = await createStore();
      await store.put(c1, createData(), []);
      const r2 = await store.put(c1, createDifferentData(), [], undefined, {
        skipIfUnchanged: true,
      });
      expect(r2.ok).toBe(true);
      if (r2.ok) {
        expect(r2.value).toBeDefined();
      }

      const listResult = await store.list(c1);
      expect(listResult.ok).toBe(true);
      if (listResult.ok) {
        expect(listResult.value.length).toBe(2);
      }
      await store.close();
    });

    test("skipIfUnchanged=false always writes", async () => {
      const store = await createStore();
      const data = createData();
      await store.put(c1, data, []);
      const r2 = await store.put(c1, data, [], undefined, { skipIfUnchanged: false });
      expect(r2.ok).toBe(true);
      if (r2.ok) {
        expect(r2.value).toBeDefined();
      }
      await store.close();
    });

    test("skipIfUnchanged on empty chain always writes", async () => {
      const store = await createStore();
      const r1 = await store.put(c1, createData(), [], undefined, { skipIfUnchanged: true });
      expect(r1.ok).toBe(true);
      if (r1.ok) {
        expect(r1.value).toBeDefined();
      }
      await store.close();
    });

    test("nodes have non-empty contentHash", async () => {
      const store = await createStore();
      const r = await store.put(c1, createData(), []);
      expect(r.ok).toBe(true);
      if (r.ok && r.value !== undefined) {
        expect(r.value.contentHash.length).toBeGreaterThan(0);
      }
      await store.close();
    });
  });

  // -----------------------------------------------------------------------
  // DAG topology
  // -----------------------------------------------------------------------
  describe("DAG topology", () => {
    test("root node has empty parentIds", async () => {
      const store = await createStore();
      const r = await store.put(c1, createData(), []);
      expect(r.ok).toBe(true);
      if (r.ok && r.value !== undefined) {
        expect(r.value.parentIds).toEqual([]);
      }
      await store.close();
    });

    test("linear chain: each node has one parent", async () => {
      const store = await createStore();
      const r1 = await store.put(c1, createData(), []);
      expect(r1.ok).toBe(true);
      if (!r1.ok || r1.value === undefined) return;

      const r2 = await store.put(c1, createData(), [r1.value.nodeId]);
      expect(r2.ok).toBe(true);
      if (r2.ok && r2.value !== undefined) {
        expect(r2.value.parentIds).toEqual([r1.value.nodeId]);
      }
      await store.close();
    });

    test("branch: two nodes share same parent", async () => {
      const store = await createStore();
      const root = await store.put(c1, createData(), []);
      expect(root.ok).toBe(true);
      if (!root.ok || root.value === undefined) return;

      const b1 = await store.put(c1, createData(), [root.value.nodeId]);
      const b2 = await store.put(c1, createDifferentData(), [root.value.nodeId]);
      expect(b1.ok).toBe(true);
      expect(b2.ok).toBe(true);
      if (b1.ok && b1.value !== undefined) {
        expect(b1.value.parentIds).toEqual([root.value.nodeId]);
      }
      if (b2.ok && b2.value !== undefined) {
        expect(b2.value.parentIds).toEqual([root.value.nodeId]);
      }
      await store.close();
    });

    test("merge: node with multiple parents", async () => {
      const store = await createStore();
      const root = await store.put(c1, createData(), []);
      expect(root.ok).toBe(true);
      if (!root.ok || root.value === undefined) return;

      const b1 = await store.put(c1, createData(), [root.value.nodeId]);
      const b2 = await store.put(c1, createDifferentData(), [root.value.nodeId]);
      expect(b1.ok && b2.ok).toBe(true);
      if (!b1.ok || !b2.ok || b1.value === undefined || b2.value === undefined) return;

      const merge = await store.put(c1, createData(), [b1.value.nodeId, b2.value.nodeId]);
      expect(merge.ok).toBe(true);
      if (merge.ok && merge.value !== undefined) {
        expect(merge.value.parentIds).toHaveLength(2);
        expect(merge.value.parentIds).toContain(b1.value.nodeId);
        expect(merge.value.parentIds).toContain(b2.value.nodeId);
      }
      await store.close();
    });

    test("fork creates independent chain from source node", async () => {
      const store = await createStore();
      const r1 = await store.put(c1, createData(), []);
      expect(r1.ok).toBe(true);
      if (!r1.ok || r1.value === undefined) return;

      const forkResult = await store.fork(r1.value.nodeId, c2, "experiment");
      expect(forkResult.ok).toBe(true);
      if (forkResult.ok) {
        expect(forkResult.value.parentNodeId).toBe(r1.value.nodeId);
        expect(forkResult.value.label).toBe("experiment");
      }

      // c2 should have the source node accessible
      const headResult = await store.head(c2);
      expect(headResult.ok).toBe(true);
      if (headResult.ok) {
        expect(headResult.value).toBeDefined();
        expect(headResult.value?.nodeId).toBe(r1.value.nodeId);
      }
      await store.close();
    });

    test("fork isolation: changes in forked chain do not affect source", async () => {
      const store = await createStore();
      const r1 = await store.put(c1, createData(), []);
      expect(r1.ok).toBe(true);
      if (!r1.ok || r1.value === undefined) return;

      await store.fork(r1.value.nodeId, c2, "fork");
      await store.put(c2, createDifferentData(), [r1.value.nodeId]);

      // Source chain should still have only 1 node
      const listResult = await store.list(c1);
      expect(listResult.ok).toBe(true);
      if (listResult.ok) {
        expect(listResult.value.length).toBe(1);
      }
      await store.close();
    });

    test("put with invalid parentId returns VALIDATION", async () => {
      const store = await createStore();
      const result = await store.put(c1, createData(), [nodeId("nonexistent")]);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("VALIDATION");
      }
      await store.close();
    });

    test("fork with unknown source nodeId returns NOT_FOUND", async () => {
      const store = await createStore();
      const result = await store.fork(nodeId("nonexistent"), c2, "label");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("NOT_FOUND");
      }
      await store.close();
    });
  });

  // -----------------------------------------------------------------------
  // Ancestor walking
  // -----------------------------------------------------------------------
  describe("ancestor walking", () => {
    test("ancestors returns full chain from node to root", async () => {
      const store = await createStore();
      const r1 = await store.put(c1, createData(), []);
      expect(r1.ok).toBe(true);
      if (!r1.ok || r1.value === undefined) return;

      const r2 = await store.put(c1, createData(), [r1.value.nodeId]);
      expect(r2.ok).toBe(true);
      if (!r2.ok || r2.value === undefined) return;

      const r3 = await store.put(c1, createData(), [r2.value.nodeId]);
      expect(r3.ok).toBe(true);
      if (!r3.ok || r3.value === undefined) return;

      const result = await store.ancestors({ startNodeId: r3.value.nodeId });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.length).toBe(3);
        expect(result.value[0]?.nodeId).toBe(r3.value.nodeId);
        expect(result.value[1]?.nodeId).toBe(r2.value.nodeId);
        expect(result.value[2]?.nodeId).toBe(r1.value.nodeId);
      }
      await store.close();
    });

    test("ancestors from root returns only root", async () => {
      const store = await createStore();
      const r1 = await store.put(c1, createData(), []);
      expect(r1.ok).toBe(true);
      if (!r1.ok || r1.value === undefined) return;

      const result = await store.ancestors({ startNodeId: r1.value.nodeId });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.length).toBe(1);
        expect(result.value[0]?.nodeId).toBe(r1.value.nodeId);
      }
      await store.close();
    });

    test("ancestors with maxDepth limits traversal", async () => {
      const store = await createStore();
      // Build a chain of 5 nodes
      let lastNodeId: NodeId | undefined;
      for (let i = 0; i < 5; i++) {
        const parents = lastNodeId !== undefined ? [lastNodeId] : [];
        const r = await store.put(c1, createData(), parents);
        expect(r.ok).toBe(true);
        if (r.ok && r.value !== undefined) {
          lastNodeId = r.value.nodeId;
        }
      }
      if (lastNodeId === undefined) return;

      const result = await store.ancestors({ startNodeId: lastNodeId, maxDepth: 3 });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.length).toBe(3);
      }
      await store.close();
    });

    test("ancestors follows merge parents", async () => {
      const store = await createStore();
      const root = await store.put(c1, createData(), []);
      expect(root.ok).toBe(true);
      if (!root.ok || root.value === undefined) return;

      const b1 = await store.put(c1, createData(), [root.value.nodeId]);
      const b2 = await store.put(c1, createDifferentData(), [root.value.nodeId]);
      expect(b1.ok && b2.ok).toBe(true);
      if (!b1.ok || !b2.ok || b1.value === undefined || b2.value === undefined) return;

      const merge = await store.put(c1, createData(), [b1.value.nodeId, b2.value.nodeId]);
      expect(merge.ok).toBe(true);
      if (!merge.ok || merge.value === undefined) return;

      const result = await store.ancestors({ startNodeId: merge.value.nodeId });
      expect(result.ok).toBe(true);
      if (result.ok) {
        // merge + b1 + b2 + root = 4 unique nodes
        expect(result.value.length).toBe(4);
        const ids = result.value.map((n: { readonly nodeId: NodeId }) => n.nodeId);
        expect(ids).toContain(merge.value.nodeId);
        expect(ids).toContain(b1.value.nodeId);
        expect(ids).toContain(b2.value.nodeId);
        expect(ids).toContain(root.value.nodeId);
      }
      await store.close();
    });

    test("ancestors with unknown startNodeId returns NOT_FOUND", async () => {
      const store = await createStore();
      const result = await store.ancestors({ startNodeId: nodeId("nonexistent") });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("NOT_FOUND");
      }
      await store.close();
    });
  });

  // -----------------------------------------------------------------------
  // Pruning
  // -----------------------------------------------------------------------
  describe("pruning", () => {
    test("retainCount prunes oldest nodes", async () => {
      const store = await createStore();
      for (let i = 0; i < 5; i++) {
        await store.put(c1, createData(), []);
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
      await store.close();
    });

    test("retainDuration prunes old nodes", async () => {
      const store = await createStore();
      // Put nodes (they all get created "now" so none should be pruned with a large duration)
      for (let i = 0; i < 3; i++) {
        await store.put(c1, createData(), []);
      }

      // Retain duration of 1 hour — nothing should be pruned
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
      await store.close();
    });

    test("prune on empty chain returns 0", async () => {
      const store = await createStore();
      const result = await store.prune(c1, { retainCount: 5 });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(0);
      }
      await store.close();
    });

    test("prune retainCount larger than chain size removes nothing", async () => {
      const store = await createStore();
      for (let i = 0; i < 3; i++) {
        await store.put(c1, createData(), []);
      }

      const result = await store.prune(c1, { retainCount: 10 });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(0);
      }
      await store.close();
    });
  });

  // -----------------------------------------------------------------------
  // Edge cases
  // -----------------------------------------------------------------------
  describe("edge cases", () => {
    test("unicode in metadata", async () => {
      const store = await createStore();
      const meta = { name: "工具-名前-도구", emoji: "🤖" };
      const r = await store.put(c1, createData(), [], meta);
      expect(r.ok).toBe(true);
      if (r.ok && r.value !== undefined) {
        expect(r.value.metadata).toEqual(meta);
      }
      await store.close();
    });

    test("100-node linear chain", async () => {
      const store = await createStore();
      let lastNodeId: NodeId | undefined;
      for (let i = 0; i < 100; i++) {
        const parents = lastNodeId !== undefined ? [lastNodeId] : [];
        const r = await store.put(c1, createData(), parents);
        expect(r.ok).toBe(true);
        if (r.ok && r.value !== undefined) {
          lastNodeId = r.value.nodeId;
        }
      }

      const listResult = await store.list(c1);
      expect(listResult.ok).toBe(true);
      if (listResult.ok) {
        expect(listResult.value.length).toBe(100);
      }
      await store.close();
    });

    test("close is idempotent", async () => {
      const store = await createStore();
      await store.close();
      // Second close should not throw
      await store.close();
    });

    test("chains are isolated from each other", async () => {
      const store = await createStore();
      await store.put(c1, createData(), []);
      await store.put(c1, createData(), []);
      await store.put(c2, createDifferentData(), []);

      const list1 = await store.list(c1);
      const list2 = await store.list(c2);
      expect(list1.ok).toBe(true);
      expect(list2.ok).toBe(true);
      if (list1.ok && list2.ok) {
        expect(list1.value.length).toBe(2);
        expect(list2.value.length).toBe(1);
      }
      await store.close();
    });
  });
}
