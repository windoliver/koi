/**
 * Shared parameterized contract tests for SnapshotChainStore implementations.
 *
 * Runs the same test suite against both createInMemorySnapshotChainStore
 * and createSqliteSnapshotChainStore to verify behavioral equivalence.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChainId, NodeId, SnapshotChainStore } from "@koi/core";
import { chainId, nodeId } from "@koi/core";
import { createInMemorySnapshotChainStore } from "../memory-store.js";
import { createSqliteSnapshotChainStore } from "../sqlite-store.js";

const factories = [
  {
    name: "in-memory",
    create: (): SnapshotChainStore<string> => createInMemorySnapshotChainStore<string>(),
  },
  {
    name: "sqlite",
    create: (): SnapshotChainStore<string> =>
      createSqliteSnapshotChainStore<string>(join(tmpdir(), `koi-test-${crypto.randomUUID()}.db`)),
  },
] as const;

for (const { name, create } of factories) {
  describe(`SnapshotChainStore [${name}]`, () => {
    let store: SnapshotChainStore<string>;

    afterEach(() => {
      store?.close();
    });

    const c1: ChainId = chainId("chain-1");
    const c2: ChainId = chainId("chain-2");

    // -------------------------------------------------------------------
    // 1. put and get a single node
    // -------------------------------------------------------------------
    test("put and get a single node", async () => {
      store = create();
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

    // -------------------------------------------------------------------
    // 2. head returns latest node
    // -------------------------------------------------------------------
    test("head returns latest node", async () => {
      store = create();
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

    // -------------------------------------------------------------------
    // 3. head returns undefined for empty chain
    // -------------------------------------------------------------------
    test("head returns undefined for empty chain", async () => {
      store = create();
      const result = await store.head(c1);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBeUndefined();
      }
    });

    // -------------------------------------------------------------------
    // 4. list returns nodes newest-first
    // -------------------------------------------------------------------
    test("list returns nodes newest-first", async () => {
      store = create();
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

    // -------------------------------------------------------------------
    // 5. put with parentIds validates parents exist
    // -------------------------------------------------------------------
    test("put with parentIds validates parents exist", async () => {
      store = create();
      const result = await store.put(c1, "orphan", [nodeId("nonexistent")]);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("VALIDATION");
      }
    });

    // -------------------------------------------------------------------
    // 6. put with skipIfUnchanged skips when content unchanged
    // -------------------------------------------------------------------
    test("put with skipIfUnchanged skips when content unchanged", async () => {
      store = create();
      const r1 = await store.put(c1, "stable", [], undefined, {
        skipIfUnchanged: true,
      });
      expect(r1.ok).toBe(true);
      if (r1.ok) expect(r1.value).toBeDefined();

      // Same data — should be skipped
      const r2 = await store.put(c1, "stable", [], undefined, {
        skipIfUnchanged: true,
      });
      expect(r2.ok).toBe(true);
      if (r2.ok) expect(r2.value).toBeUndefined();

      // Chain should still have only 1 node
      const listResult = await store.list(c1);
      expect(listResult.ok).toBe(true);
      if (listResult.ok) expect(listResult.value.length).toBe(1);
    });

    // -------------------------------------------------------------------
    // 7. ancestors walks parent chain (BFS)
    // -------------------------------------------------------------------
    test("ancestors walks parent chain (BFS)", async () => {
      store = create();
      const r1 = await store.put(c1, "root", []);
      expect(r1.ok).toBe(true);
      if (!r1.ok || r1.value === undefined) return;

      const r2 = await store.put(c1, "child", [r1.value.nodeId]);
      expect(r2.ok).toBe(true);
      if (!r2.ok || r2.value === undefined) return;

      const r3 = await store.put(c1, "grandchild", [r2.value.nodeId]);
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
    });

    // -------------------------------------------------------------------
    // 8. ancestors respects maxDepth
    // -------------------------------------------------------------------
    test("ancestors respects maxDepth", async () => {
      store = create();
      let lastNodeId: NodeId | undefined;
      for (let i = 0; i < 5; i++) {
        const parents = lastNodeId !== undefined ? [lastNodeId] : [];
        const r = await store.put(c1, `node-${i}`, parents);
        expect(r.ok).toBe(true);
        if (r.ok && r.value !== undefined) {
          lastNodeId = r.value.nodeId;
        }
      }
      if (lastNodeId === undefined) return;

      const result = await store.ancestors({
        startNodeId: lastNodeId,
        maxDepth: 3,
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.length).toBe(3);
      }
    });

    // -------------------------------------------------------------------
    // 9. fork creates new chain from existing node
    // -------------------------------------------------------------------
    test("fork creates new chain from existing node", async () => {
      store = create();
      const r1 = await store.put(c1, "origin", []);
      expect(r1.ok).toBe(true);
      if (!r1.ok || r1.value === undefined) return;

      const forkResult = await store.fork(r1.value.nodeId, c2, "experiment");
      expect(forkResult.ok).toBe(true);
      if (forkResult.ok) {
        expect(forkResult.value.parentNodeId).toBe(r1.value.nodeId);
        expect(forkResult.value.label).toBe("experiment");
      }

      // c2 should have the source node as head
      const headResult = await store.head(c2);
      expect(headResult.ok).toBe(true);
      if (headResult.ok) {
        expect(headResult.value).toBeDefined();
        expect(headResult.value?.nodeId).toBe(r1.value.nodeId);
      }

      // c2 list should include the forked node
      const listResult = await store.list(c2);
      expect(listResult.ok).toBe(true);
      if (listResult.ok) {
        expect(listResult.value.length).toBe(1);
      }
    });

    // -------------------------------------------------------------------
    // 10. prune with retainCount
    // -------------------------------------------------------------------
    test("prune with retainCount", async () => {
      store = create();
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

    // -------------------------------------------------------------------
    // 11. prune with retainDuration
    // -------------------------------------------------------------------
    test("prune with retainDuration preserves recent nodes", async () => {
      store = create();
      for (let i = 0; i < 3; i++) {
        await store.put(c1, `node-${i}`, []);
      }

      // Retain duration of 1 hour — nothing should be pruned (all nodes are recent)
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

    // -------------------------------------------------------------------
    // 12. prune protects branch heads by default
    // -------------------------------------------------------------------
    test("prune protects branch heads by default", async () => {
      store = create();
      for (let i = 0; i < 5; i++) {
        await store.put(c1, `node-${i}`, []);
      }

      // Prune to keep 0 — but head should be protected
      const pruneResult = await store.prune(c1, { retainCount: 0 });
      expect(pruneResult.ok).toBe(true);
      if (pruneResult.ok) {
        // 4 removed (head at index 0 protected)
        expect(pruneResult.value).toBe(4);
      }

      // Head should still be accessible
      const headResult = await store.head(c1);
      expect(headResult.ok).toBe(true);
      if (headResult.ok) {
        expect(headResult.value).toBeDefined();
      }
    });

    // -------------------------------------------------------------------
    // 13. close releases resources
    // -------------------------------------------------------------------
    test("close releases resources", async () => {
      store = create();
      await store.put(c1, "before-close", []);
      await store.close();
      // Second close should not throw (idempotent)
      await store.close();
    });
  });
}
