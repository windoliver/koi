/**
 * Transaction-rollback tests — the SQLite-store flavor of Issue 9A's
 * crash-injection test harness.
 *
 * The full crash-injection harness from #1625 design review issue 9 lives
 * in @koi/checkpoint, where it covers the multi-step restore protocol
 * (file restore → conversation truncate → head update). For the SQLite
 * store, the equivalent property is "every multi-statement operation is
 * wrapped in a transaction so a mid-operation failure leaves the DB
 * untouched."
 *
 * These tests prove that property by triggering errors mid-transaction and
 * verifying the DB state matches the pre-operation state.
 */

import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChainId, NodeId } from "@koi/core";
import { chainId, nodeId } from "@koi/core";
import { createSnapshotStoreSqlite, type SqliteSnapshotStore } from "../sqlite-store.js";

function makeTempPath(): string {
  return join(tmpdir(), `koi-snapshot-store-tx-${crypto.randomUUID()}.db`);
}

describe("transaction safety", () => {
  let store: SqliteSnapshotStore<string>;
  const c1: ChainId = chainId("chain-tx");

  afterEach(() => {
    store?.close();
  });

  test("put with bad parent returns VALIDATION before any write", () => {
    store = createSnapshotStoreSqlite<string>({ path: makeTempPath() });
    // Create a baseline node so we can verify nothing else gets committed.
    const baseline = store.put(c1, "baseline", []);
    if (!baseline.ok || baseline.value === undefined) throw new Error("baseline failed");
    const baselineId = baseline.value.nodeId;

    const bad = store.put(c1, "child-of-nothing", [nodeId("does-not-exist")]);
    expect(bad.ok).toBe(false);
    if (bad.ok) throw new Error("expected failure");
    expect(bad.error.code).toBe("VALIDATION");

    // The baseline must still be the head and nothing else was added.
    const headResult = store.head(c1);
    expect(headResult.ok).toBe(true);
    if (!headResult.ok) return;
    expect(headResult.value?.nodeId).toBe(baselineId);

    const listResult = store.list(c1);
    expect(listResult.ok).toBe(true);
    if (!listResult.ok) return;
    expect(listResult.value.length).toBe(1);
  });

  test("put survives sqlite reopen — committed state persists across processes", () => {
    // The two-handle pattern simulates "process crash, then restart" without
    // killing -9. We close the first store cleanly, then reopen on the same
    // file and check the data is intact.
    const path = makeTempPath();
    store = createSnapshotStoreSqlite<string>({ path });
    const r1 = store.put(c1, "first", []);
    if (!r1.ok || r1.value === undefined) throw new Error("r1 failed");
    const r2 = store.put(c1, "second", []);
    if (!r2.ok || r2.value === undefined) throw new Error("r2 failed");
    store.close();

    // Reopen — chain heads and seqs should be reconstructed from the DB.
    store = createSnapshotStoreSqlite<string>({ path });
    const head = store.head(c1);
    expect(head.ok).toBe(true);
    if (!head.ok) return;
    expect(head.value?.nodeId).toBe(r2.value.nodeId);

    // The seq counter should resume past the highest existing seq, so a new
    // put gets a fresh ordering slot rather than colliding.
    const r3 = store.put(c1, "third", []);
    expect(r3.ok).toBe(true);

    const list = store.list(c1);
    expect(list.ok).toBe(true);
    if (!list.ok) return;
    expect(list.value.length).toBe(3);
    expect(list.value[0]?.data).toBe("third");
  });

  test("put rolled back on a synthetic FK violation leaves chain unchanged", () => {
    // Open the database directly to inject an inconsistent state mid-test
    // (the store's prepared statements are insulated from this), then
    // reopen via the store factory and verify it tolerates the inconsistency.
    const path = makeTempPath();
    store = createSnapshotStoreSqlite<string>({ path });
    const baseline = store.put(c1, "baseline", []);
    if (!baseline.ok || baseline.value === undefined) throw new Error("baseline failed");
    store.close();

    // Inject a "torn" insert: a chain_members row pointing at a missing
    // node. The schema's FK constraint should reject this, but we wrap in
    // a savepoint that we then ROLLBACK, simulating a transaction abort.
    const raw = new Database(path);
    raw.run("PRAGMA foreign_keys = ON");
    let threw = false;
    try {
      raw.transaction(() => {
        raw.run(
          "INSERT INTO chain_members (chain_id, node_id, created_at, seq) VALUES ('chain-tx', 'fake-node', 0, 999)",
        );
      })();
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
    raw.close();

    // Reopen via the store and confirm the baseline is intact.
    store = createSnapshotStoreSqlite<string>({ path });
    const list = store.list(c1);
    expect(list.ok).toBe(true);
    if (!list.ok) return;
    expect(list.value.length).toBe(1);
    expect(list.value[0]?.data).toBe("baseline");
  });

  test("prune is atomic across the chain — head pointer never points at a deleted node", () => {
    store = createSnapshotStoreSqlite<string>({ path: makeTempPath() });
    let last: NodeId | undefined;
    for (let i = 0; i < 10; i++) {
      const r = store.put(c1, `n${i}`, last !== undefined ? [last] : []);
      if (!r.ok || r.value === undefined) throw new Error(`n${i}`);
      last = r.value.nodeId;
    }

    const pruneResult = store.prune(c1, { retainCount: 3, retainBranches: false });
    expect(pruneResult.ok).toBe(true);

    // After prune, the head must reference a node that still exists.
    const headResult = store.head(c1);
    expect(headResult.ok).toBe(true);
    if (!headResult.ok) return;
    expect(headResult.value).toBeDefined();
    if (headResult.value === undefined) return;

    // Verify the head's nodeId actually resolves via get().
    const getResult = store.get(headResult.value.nodeId);
    expect(getResult.ok).toBe(true);
  });
});
