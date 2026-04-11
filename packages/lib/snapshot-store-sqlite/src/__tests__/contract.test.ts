/**
 * Contract test suite — ports the 14 v1 tests from
 * `archive/v1/packages/mm/snapshot-chain-store/src/__tests__/store-contract.test.ts`.
 *
 * These tests verify the core `SnapshotChainStore<T>` semantics: put/get/head,
 * list ordering, parent validation, content-hash dedup, ancestor walking,
 * fork, and prune (with retainCount, retainDuration, head protection,
 * retainBranches=false).
 */

import { afterEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChainId, NodeId } from "@koi/core";
import { chainId, nodeId } from "@koi/core";
import { createSnapshotStoreSqlite, type SqliteSnapshotStore } from "../sqlite-store.js";

function makeTempPath(): string {
  return join(tmpdir(), `koi-snapshot-store-test-${crypto.randomUUID()}.db`);
}

describe("SnapshotChainStore [sqlite] — contract", () => {
  let store: SqliteSnapshotStore<string>;

  afterEach(() => {
    store?.close();
  });

  const c1: ChainId = chainId("chain-1");
  const c2: ChainId = chainId("chain-2");

  test("put and get a single node", () => {
    store = createSnapshotStoreSqlite<string>({ path: makeTempPath() });
    const putResult = store.put(c1, "hello", []);
    expect(putResult.ok).toBe(true);
    if (!putResult.ok || putResult.value === undefined) return;

    const getResult = store.get(putResult.value.nodeId);
    expect(getResult.ok).toBe(true);
    if (getResult.ok) {
      expect(getResult.value.data).toBe("hello");
      expect(getResult.value.chainId).toBe(c1);
      expect(getResult.value.parentIds).toEqual([]);
    }
  });

  test("head returns latest node", () => {
    store = createSnapshotStoreSqlite<string>({ path: makeTempPath() });
    store.put(c1, "first", []);
    const r2 = store.put(c1, "second", []);
    expect(r2.ok).toBe(true);
    if (!r2.ok || r2.value === undefined) return;

    const headResult = store.head(c1);
    expect(headResult.ok).toBe(true);
    if (headResult.ok) {
      expect(headResult.value?.nodeId).toBe(r2.value.nodeId);
      expect(headResult.value?.data).toBe("second");
    }
  });

  test("head returns undefined for empty chain", () => {
    store = createSnapshotStoreSqlite<string>({ path: makeTempPath() });
    const result = store.head(c1);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBeUndefined();
    }
  });

  test("list returns nodes newest-first", () => {
    store = createSnapshotStoreSqlite<string>({ path: makeTempPath() });
    const r1 = store.put(c1, "first", []);
    const r2 = store.put(c1, "second", []);
    const r3 = store.put(c1, "third", []);
    expect(r1.ok && r2.ok && r3.ok).toBe(true);

    const listResult = store.list(c1);
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

  test("put with parentIds validates parents exist", () => {
    store = createSnapshotStoreSqlite<string>({ path: makeTempPath() });
    const result = store.put(c1, "orphan", [nodeId("nonexistent")]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
    }
  });

  test("put with skipIfUnchanged skips when content unchanged", () => {
    store = createSnapshotStoreSqlite<string>({ path: makeTempPath() });
    const r1 = store.put(c1, "stable", [], undefined, { skipIfUnchanged: true });
    expect(r1.ok).toBe(true);
    if (r1.ok) expect(r1.value).toBeDefined();

    const r2 = store.put(c1, "stable", [], undefined, { skipIfUnchanged: true });
    expect(r2.ok).toBe(true);
    if (r2.ok) expect(r2.value).toBeUndefined();

    const listResult = store.list(c1);
    expect(listResult.ok).toBe(true);
    if (listResult.ok) expect(listResult.value.length).toBe(1);
  });

  test("ancestors walks parent chain (BFS order)", () => {
    store = createSnapshotStoreSqlite<string>({ path: makeTempPath() });
    const r1 = store.put(c1, "root", []);
    if (!r1.ok || r1.value === undefined) throw new Error("r1 failed");
    const r2 = store.put(c1, "child", [r1.value.nodeId]);
    if (!r2.ok || r2.value === undefined) throw new Error("r2 failed");
    const r3 = store.put(c1, "grandchild", [r2.value.nodeId]);
    if (!r3.ok || r3.value === undefined) throw new Error("r3 failed");

    const result = store.ancestors({ startNodeId: r3.value.nodeId });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.length).toBe(3);
      // Ordered by depth ASC: start node first, then parents.
      expect(result.value[0]?.nodeId).toBe(r3.value.nodeId);
      expect(result.value[1]?.nodeId).toBe(r2.value.nodeId);
      expect(result.value[2]?.nodeId).toBe(r1.value.nodeId);
    }
  });

  test("ancestors respects maxDepth", () => {
    store = createSnapshotStoreSqlite<string>({ path: makeTempPath() });
    let lastNodeId: NodeId | undefined;
    for (let i = 0; i < 5; i++) {
      const parents = lastNodeId !== undefined ? [lastNodeId] : [];
      const r = store.put(c1, `node-${i}`, parents);
      expect(r.ok).toBe(true);
      if (r.ok && r.value !== undefined) {
        lastNodeId = r.value.nodeId;
      }
    }
    if (lastNodeId === undefined) throw new Error("no nodes created");

    // maxDepth=2 → return start (depth 0) + 1 ancestor (depth 1) + 1 (depth 2)
    // == 3 nodes total. The CTE walks up to depth <= maxDepth.
    const result = store.ancestors({ startNodeId: lastNodeId, maxDepth: 2 });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.length).toBe(3);
    }
  });

  test("fork creates new chain from existing node", () => {
    store = createSnapshotStoreSqlite<string>({ path: makeTempPath() });
    const r1 = store.put(c1, "origin", []);
    if (!r1.ok || r1.value === undefined) throw new Error("r1 failed");

    const forkResult = store.fork(r1.value.nodeId, c2, "experiment");
    expect(forkResult.ok).toBe(true);
    if (forkResult.ok) {
      expect(forkResult.value.parentNodeId).toBe(r1.value.nodeId);
      expect(forkResult.value.label).toBe("experiment");
    }

    const headResult = store.head(c2);
    expect(headResult.ok).toBe(true);
    if (headResult.ok) {
      expect(headResult.value).toBeDefined();
      expect(headResult.value?.nodeId).toBe(r1.value.nodeId);
    }

    const listResult = store.list(c2);
    expect(listResult.ok).toBe(true);
    if (listResult.ok) {
      expect(listResult.value.length).toBe(1);
    }
  });

  test("prune with retainCount keeps newest N", () => {
    store = createSnapshotStoreSqlite<string>({ path: makeTempPath() });
    for (let i = 0; i < 5; i++) {
      store.put(c1, `node-${i}`, []);
    }

    const pruneResult = store.prune(c1, { retainCount: 3 });
    expect(pruneResult.ok).toBe(true);
    if (pruneResult.ok) {
      expect(pruneResult.value).toBe(2);
    }

    const listResult = store.list(c1);
    expect(listResult.ok).toBe(true);
    if (listResult.ok) {
      expect(listResult.value.length).toBe(3);
    }
  });

  test("prune with retainDuration preserves recent nodes", () => {
    store = createSnapshotStoreSqlite<string>({ path: makeTempPath() });
    for (let i = 0; i < 3; i++) {
      store.put(c1, `node-${i}`, []);
    }

    // 1-hour window — all nodes are recent, nothing should be pruned.
    const result = store.prune(c1, { retainDuration: 3600000 });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe(0);
    }

    const listResult = store.list(c1);
    expect(listResult.ok).toBe(true);
    if (listResult.ok) {
      expect(listResult.value.length).toBe(3);
    }
  });

  test("prune protects branch heads by default", () => {
    store = createSnapshotStoreSqlite<string>({ path: makeTempPath() });
    for (let i = 0; i < 5; i++) {
      store.put(c1, `node-${i}`, []);
    }

    // retainCount=0 + default retainBranches=true → head is still preserved
    const pruneResult = store.prune(c1, { retainCount: 0 });
    expect(pruneResult.ok).toBe(true);
    if (pruneResult.ok) {
      expect(pruneResult.value).toBe(4);
    }

    const headResult = store.head(c1);
    expect(headResult.ok).toBe(true);
    if (headResult.ok) {
      expect(headResult.value).toBeDefined();
    }
  });

  test("prune with retainBranches: false updates head when head is removed", () => {
    store = createSnapshotStoreSqlite<string>({ path: makeTempPath() });
    for (let i = 0; i < 3; i++) {
      store.put(c1, `node-${i}`, []);
    }

    const pruneResult = store.prune(c1, { retainCount: 1, retainBranches: false });
    expect(pruneResult.ok).toBe(true);
    if (pruneResult.ok) {
      expect(pruneResult.value).toBe(2);
    }

    const headResult = store.head(c1);
    expect(headResult.ok).toBe(true);
    if (headResult.ok) {
      expect(headResult.value).toBeDefined();
      expect(headResult.value?.data).toBe("node-2");
    }

    const listResult = store.list(c1);
    expect(listResult.ok).toBe(true);
    if (listResult.ok) {
      expect(listResult.value.length).toBe(1);
    }
  });

  test("close releases resources and is idempotent", () => {
    store = createSnapshotStoreSqlite<string>({ path: makeTempPath() });
    store.put(c1, "before-close", []);
    store.close();
    store.close(); // double-close must not throw
  });

  test("close prevents further operations", () => {
    store = createSnapshotStoreSqlite<string>({ path: makeTempPath() });
    store.close();
    const result = store.put(c1, "after-close", []);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("INTERNAL");
    }
  });

  // ---------------------------------------------------------------------------
  // updatePayload — two-phase capture support
  // ---------------------------------------------------------------------------

  test("updatePayload rewrites data without changing nodeId or parents", () => {
    store = createSnapshotStoreSqlite<string>({ path: makeTempPath() });
    const put = store.put(c1, "initial", []);
    expect(put.ok).toBe(true);
    if (!put.ok || put.value === undefined) return;
    const original = put.value;

    const upd = store.updatePayload(original.nodeId, "updated");
    expect(upd.ok).toBe(true);

    const reread = store.get(original.nodeId);
    expect(reread.ok).toBe(true);
    if (!reread.ok) return;
    expect(reread.value.nodeId).toBe(original.nodeId);
    expect(reread.value.parentIds).toEqual(original.parentIds);
    expect(reread.value.chainId).toBe(original.chainId);
    expect(reread.value.createdAt).toBe(original.createdAt);
    expect(reread.value.data).toBe("updated");
    // Content hash is recomputed from new data — must differ from the original.
    expect(reread.value.contentHash).not.toBe(original.contentHash);
  });

  test("updatePayload preserves metadata", () => {
    store = createSnapshotStoreSqlite<string>({ path: makeTempPath() });
    const put = store.put(c1, "initial", [], { "koi:snapshot_status": "complete" });
    expect(put.ok).toBe(true);
    if (!put.ok || put.value === undefined) return;

    const upd = store.updatePayload(put.value.nodeId, "updated");
    expect(upd.ok).toBe(true);

    const reread = store.get(put.value.nodeId);
    expect(reread.ok).toBe(true);
    if (!reread.ok) return;
    expect(reread.value.metadata["koi:snapshot_status"]).toBe("complete");
  });

  test("updatePayload returns NOT_FOUND for a missing node", () => {
    store = createSnapshotStoreSqlite<string>({ path: makeTempPath() });
    const result = store.updatePayload("node-does-not-exist" as never, "x");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("NOT_FOUND");
  });

  test("head() reflects the updated payload after updatePayload", () => {
    store = createSnapshotStoreSqlite<string>({ path: makeTempPath() });
    const put = store.put(c1, "initial", []);
    expect(put.ok).toBe(true);
    if (!put.ok || put.value === undefined) return;

    store.updatePayload(put.value.nodeId, "updated-via-update");

    const h = store.head(c1);
    expect(h.ok).toBe(true);
    if (!h.ok || h.value === undefined) return;
    expect(h.value.nodeId).toBe(put.value.nodeId);
    expect(h.value.data).toBe("updated-via-update");
  });
});
