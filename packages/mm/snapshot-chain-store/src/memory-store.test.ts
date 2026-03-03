import { describe, expect, test } from "bun:test";
import type { ChainId, NodeId } from "@koi/core";
import { runSnapshotChainStoreContractTests } from "@koi/test-utils";
import { createInMemorySnapshotChainStore } from "./memory-store.js";

interface TestData {
  readonly name: string;
  readonly value: number;
}

describe("InMemorySnapshotChainStore", () => {
  runSnapshotChainStoreContractTests<TestData>(
    () => createInMemorySnapshotChainStore<TestData>(),
    () => ({ name: "test", value: Math.random() }),
    () => ({ name: "different", value: -1 }),
  );

  // -------------------------------------------------------------------------
  // Backend-specific: large DAG ancestor walking
  // -------------------------------------------------------------------------
  describe("large DAG ancestor walking", () => {
    test("walks 200-node linear chain efficiently", async () => {
      const store = createInMemorySnapshotChainStore<TestData>();
      const cid = "long-chain" as ChainId;
      // let justified: track latest node for parent linking
      let lastNodeId: NodeId | undefined;

      for (let i = 0; i < 200; i++) {
        const parents = lastNodeId !== undefined ? [lastNodeId] : [];
        const result = await store.put(cid, { name: `node-${i}`, value: i }, parents);
        expect(result.ok).toBe(true);
        if (result.ok && result.value !== undefined) {
          lastNodeId = result.value.nodeId;
        }
      }

      expect(lastNodeId).toBeDefined();
      // Walk from leaf — should visit all 200 nodes
      const ancestors = await store.ancestors({ startNodeId: lastNodeId as NodeId });
      expect(ancestors.ok).toBe(true);
      if (ancestors.ok) {
        expect(ancestors.value.length).toBe(200);
      }

      store.close();
    });

    test("maxDepth limits traversal in deep chain", async () => {
      const store = createInMemorySnapshotChainStore<TestData>();
      const cid = "depth-limit" as ChainId;
      // let justified: track latest node for parent linking
      let lastNodeId: NodeId | undefined;

      for (let i = 0; i < 100; i++) {
        const parents = lastNodeId !== undefined ? [lastNodeId] : [];
        const result = await store.put(cid, { name: `n-${i}`, value: i }, parents);
        expect(result.ok).toBe(true);
        if (result.ok && result.value !== undefined) {
          lastNodeId = result.value.nodeId;
        }
      }

      expect(lastNodeId).toBeDefined();
      const ancestors = await store.ancestors({
        startNodeId: lastNodeId as NodeId,
        maxDepth: 10,
      });
      expect(ancestors.ok).toBe(true);
      if (ancestors.ok) {
        // startNode counts as depth 1, so maxDepth=10 gives 10 nodes
        expect(ancestors.value.length).toBe(10);
      }

      store.close();
    });

    test("handles wide merge DAG (diamond topology)", async () => {
      const store = createInMemorySnapshotChainStore<TestData>();
      const cid = "diamond" as ChainId;

      // Root node
      const rootResult = await store.put(cid, { name: "root", value: 0 }, []);
      expect(rootResult.ok).toBe(true);
      const rootId =
        rootResult.ok && rootResult.value !== undefined ? rootResult.value.nodeId : ("" as NodeId);

      // 50 branch nodes from root
      const branchIds: NodeId[] = [];
      for (let i = 0; i < 50; i++) {
        const result = await store.put(cid, { name: `branch-${i}`, value: i }, [rootId]);
        expect(result.ok).toBe(true);
        if (result.ok && result.value !== undefined) {
          branchIds.push(result.value.nodeId);
        }
      }

      // Merge node with all 50 branches as parents
      const mergeResult = await store.put(cid, { name: "merge", value: 99 }, branchIds);
      expect(mergeResult.ok).toBe(true);
      const mergeId =
        mergeResult.ok && mergeResult.value !== undefined
          ? mergeResult.value.nodeId
          : ("" as NodeId);

      // Walk from merge node — should see merge + 50 branches + root = 52
      const ancestors = await store.ancestors({ startNodeId: mergeId });
      expect(ancestors.ok).toBe(true);
      if (ancestors.ok) {
        expect(ancestors.value.length).toBe(52);
        // Root should appear exactly once (no duplicates)
        const rootCount = ancestors.value.filter((n) => n.nodeId === rootId).length;
        expect(rootCount).toBe(1);
      }

      store.close();
    });
  });

  // -------------------------------------------------------------------------
  // Backend-specific: content hash deduplication
  // -------------------------------------------------------------------------
  describe("content hash deduplication", () => {
    test("skipIfUnchanged skips when content hash matches", async () => {
      const store = createInMemorySnapshotChainStore<TestData>();
      const cid = "hash-dedup" as ChainId;
      const data: TestData = { name: "stable", value: 42 };

      // First put succeeds
      const r1 = await store.put(cid, data, [], undefined, { skipIfUnchanged: true });
      expect(r1.ok).toBe(true);
      if (r1.ok) expect(r1.value).toBeDefined();

      // Second put with same data — skipped
      const r2 = await store.put(cid, data, [], undefined, { skipIfUnchanged: true });
      expect(r2.ok).toBe(true);
      if (r2.ok) expect(r2.value).toBeUndefined();

      // Chain should have exactly 1 node
      const nodes = await store.list(cid);
      expect(nodes.ok).toBe(true);
      if (nodes.ok) expect(nodes.value.length).toBe(1);

      store.close();
    });

    test("skipIfUnchanged detects different data with same field names", async () => {
      const store = createInMemorySnapshotChainStore<TestData>();
      const cid = "hash-diff" as ChainId;

      const r1 = await store.put(cid, { name: "a", value: 1 }, [], undefined, {
        skipIfUnchanged: true,
      });
      expect(r1.ok).toBe(true);
      if (r1.ok) expect(r1.value).toBeDefined();

      // Different values, same shape — should NOT skip
      const r2 = await store.put(cid, { name: "a", value: 2 }, [], undefined, {
        skipIfUnchanged: true,
      });
      expect(r2.ok).toBe(true);
      if (r2.ok) expect(r2.value).toBeDefined();

      const nodes = await store.list(cid);
      expect(nodes.ok).toBe(true);
      if (nodes.ok) expect(nodes.value.length).toBe(2);

      store.close();
    });

    test("deterministic hashing: key order does not matter", async () => {
      const store = createInMemorySnapshotChainStore<Record<string, unknown>>();
      const cid = "key-order" as ChainId;

      const r1 = await store.put(cid, { a: 1, b: 2, c: 3 }, [], undefined, {
        skipIfUnchanged: true,
      });
      expect(r1.ok).toBe(true);
      if (r1.ok) expect(r1.value).toBeDefined();

      // Same data, different key insertion order — should skip
      const r2 = await store.put(cid, { c: 3, a: 1, b: 2 }, [], undefined, {
        skipIfUnchanged: true,
      });
      expect(r2.ok).toBe(true);
      if (r2.ok) expect(r2.value).toBeUndefined();

      store.close();
    });
  });

  // -------------------------------------------------------------------------
  // Backend-specific: prune with concurrent operations
  // -------------------------------------------------------------------------
  describe("prune edge cases", () => {
    test("prune removes nodes but ancestor walk still returns valid snapshot", async () => {
      const store = createInMemorySnapshotChainStore<TestData>();
      const cid = "prune-walk" as ChainId;
      // let justified: track latest and first node IDs for assertions after loop
      let lastNodeId: NodeId | undefined;

      // Build a 20-node chain
      for (let i = 0; i < 20; i++) {
        const parents = lastNodeId !== undefined ? [lastNodeId] : [];
        const result = await store.put(cid, { name: `n-${i}`, value: i }, parents);
        expect(result.ok).toBe(true);
        if (result.ok && result.value !== undefined) {
          lastNodeId = result.value.nodeId;
        }
      }

      // Prune keeping only 5 newest
      const pruneResult = await store.prune(cid, { retainCount: 5 });
      expect(pruneResult.ok).toBe(true);
      if (pruneResult.ok) expect(pruneResult.value).toBe(15);

      // Ancestor walk from leaf — should see <=5 nodes (pruned ancestors are gone)
      expect(lastNodeId).toBeDefined();
      const ancestors = await store.ancestors({ startNodeId: lastNodeId as NodeId });
      expect(ancestors.ok).toBe(true);
      if (ancestors.ok) {
        expect(ancestors.value.length).toBeLessThanOrEqual(5);
        expect(ancestors.value.length).toBeGreaterThanOrEqual(1);
      }

      store.close();
    });

    test("pruned nodes return NOT_FOUND on direct get", async () => {
      const store = createInMemorySnapshotChainStore<TestData>();
      const cid = "prune-get" as ChainId;
      // let justified: track first and latest node IDs for post-prune assertions
      let firstNodeId: NodeId | undefined;
      let lastNodeId: NodeId | undefined;

      for (let i = 0; i < 10; i++) {
        const parents = lastNodeId !== undefined ? [lastNodeId] : [];
        const result = await store.put(cid, { name: `n-${i}`, value: i }, parents);
        expect(result.ok).toBe(true);
        if (result.ok && result.value !== undefined) {
          if (firstNodeId === undefined) firstNodeId = result.value.nodeId;
          lastNodeId = result.value.nodeId;
        }
      }

      // Prune all but 2
      await store.prune(cid, { retainCount: 2 });

      // First node (oldest) should be pruned
      expect(firstNodeId).toBeDefined();
      const getResult = await store.get(firstNodeId as NodeId);
      expect(getResult.ok).toBe(false);
      if (!getResult.ok) expect(getResult.error.code).toBe("NOT_FOUND");

      // Latest node should still exist
      expect(lastNodeId).toBeDefined();
      const latestResult = await store.get(lastNodeId as NodeId);
      expect(latestResult.ok).toBe(true);

      store.close();
    });

    test("prune + put: new nodes after prune are not affected", async () => {
      const store = createInMemorySnapshotChainStore<TestData>();
      const cid = "prune-then-put" as ChainId;
      // let justified: track latest node for parent linking
      let lastNodeId: NodeId | undefined;

      for (let i = 0; i < 10; i++) {
        const parents = lastNodeId !== undefined ? [lastNodeId] : [];
        const result = await store.put(cid, { name: `n-${i}`, value: i }, parents);
        expect(result.ok).toBe(true);
        if (result.ok && result.value !== undefined) {
          lastNodeId = result.value.nodeId;
        }
      }

      // Prune to keep 2
      await store.prune(cid, { retainCount: 2 });

      // Put new node on top of head
      const headResult = await store.head(cid);
      expect(headResult.ok).toBe(true);
      if (headResult.ok && headResult.value !== undefined) {
        const newResult = await store.put(cid, { name: "post-prune", value: 999 }, [
          headResult.value.nodeId,
        ]);
        expect(newResult.ok).toBe(true);
      }

      // List should show 3 nodes (2 retained + 1 new)
      const listResult = await store.list(cid);
      expect(listResult.ok).toBe(true);
      if (listResult.ok) expect(listResult.value.length).toBe(3);

      store.close();
    });
  });
});
