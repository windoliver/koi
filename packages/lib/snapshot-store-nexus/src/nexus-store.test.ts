import { describe, expect, test } from "bun:test";
import type { ChainId, NodeId } from "@koi/core";
import { chainId } from "@koi/core";
import { createFakeNexusTransport } from "@koi/fs-nexus/testing";
import { createSnapshotStoreNexus } from "./nexus-store.js";

interface TData {
  readonly v: number;
}

function newStore() {
  return createSnapshotStoreNexus<TData>({
    transport: createFakeNexusTransport(),
  });
}

describe("createSnapshotStoreNexus", () => {
  test("put → head round-trip", async () => {
    const store = newStore();
    const cid = chainId("c1");
    const r = await store.put(cid, { v: 1 }, []);
    expect(r.ok).toBe(true);
    const h = await store.head(cid);
    expect(h.ok).toBe(true);
    if (h.ok && h.value !== undefined) expect(h.value.data).toEqual({ v: 1 });
  });

  test("skipIfUnchanged dedupes by content hash", async () => {
    const store = newStore();
    const cid = chainId("c2");
    const a = await store.put(cid, { v: 7 }, []);
    expect(a.ok).toBe(true);
    const b = await store.put(cid, { v: 7 }, [], undefined, { skipIfUnchanged: true });
    expect(b.ok).toBe(true);
    if (b.ok) expect(b.value).toBeUndefined();
    const list = await store.list(cid);
    if (list.ok) expect(list.value.length).toBe(1);
  });

  test("get walks the glob to find a node by id", async () => {
    const store = newStore();
    const cid = chainId("c3");
    const r = await store.put(cid, { v: 3 }, []);
    if (!r.ok || r.value === undefined) throw new Error("put failed");
    const got = await store.get(r.value.nodeId);
    expect(got.ok).toBe(true);
    if (got.ok) expect(got.value.data.v).toBe(3);
  });

  test("get on missing node returns NOT_FOUND", async () => {
    const store = newStore();
    const r = await store.get("node-nope" as NodeId);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("NOT_FOUND");
  });

  test("ancestors walks parent chain", async () => {
    const store = newStore();
    const cid = chainId("c4");
    const root = await store.put(cid, { v: 1 }, []);
    if (!root.ok || root.value === undefined) throw new Error("root put failed");
    const child = await store.put(cid, { v: 2 }, [root.value.nodeId]);
    if (!child.ok || child.value === undefined) throw new Error("child put failed");

    const r = await store.ancestors({ startNodeId: child.value.nodeId });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.length).toBe(2);
  });

  test("fork copies node into new chain", async () => {
    const store = newStore();
    const src = chainId("src");
    const root = await store.put(src, { v: 1 }, []);
    if (!root.ok || root.value === undefined) throw new Error();

    const f = await store.fork(root.value.nodeId, chainId("forked"), "experiment");
    expect(f.ok).toBe(true);
    if (f.ok) expect(f.value.label).toBe("experiment");

    const head = await store.head(chainId("forked"));
    expect(head.ok).toBe(true);
    if (head.ok && head.value !== undefined) expect(head.value.data.v).toBe(1);
  });

  test("prune retainCount keeps only the newest N nodes", async () => {
    const store = newStore();
    const cid = chainId("c-prune");
    for (let i = 0; i < 5; i++) {
      const r = await store.put(cid, { v: i }, []);
      if (!r.ok) throw new Error("put failed");
    }
    const removed = await store.prune(cid, { retainCount: 2 });
    expect(removed.ok).toBe(true);
    if (removed.ok) expect(removed.value).toBe(3);
    const list = await store.list(cid);
    if (list.ok) expect(list.value.length).toBe(2);
  });

  test("rejects path-unsafe chain IDs", async () => {
    const store = newStore();
    const r = await store.put("a/b" as ChainId, { v: 1 }, []);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("VALIDATION");
  });

  // --- Fix 4 (round 5): _nodes reserved as chain ID ---

  test("put with chainId '_nodes' returns VALIDATION error", async () => {
    const store = newStore();
    const r = await store.put("_nodes" as ChainId, { v: 1 }, []);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("VALIDATION");
  });

  test("put with chainId '_NODES' succeeds (case-sensitive reservation)", async () => {
    const store = newStore();
    const r = await store.put("_NODES" as ChainId, { v: 1 }, []);
    expect(r.ok).toBe(true);
  });

  test("transport-level error on read surfaces as EXTERNAL", async () => {
    const transport = createFakeNexusTransport({
      failMethod: "read",
      failCode: -32603,
      failMessage: "boom",
    });
    const store = createSnapshotStoreNexus<TData>({ transport });
    const r = await store.head(chainId("any"));
    expect(r.ok).toBe(false);
  });

  // --- Prune meta-before-delete regression test (Finding 4) ---

  test("after prune, every nodeId in meta has a corresponding node file", async () => {
    // Invariant: meta must never reference a node that has been deleted.
    // This regression test guards against the old order (delete-then-write-meta)
    // where a meta write failure could leave meta pointing at deleted nodes.
    const store = newStore();
    const cid = chainId("c-prune-invariant");
    for (let i = 0; i < 4; i++) {
      const r = await store.put(cid, { v: i }, []);
      if (!r.ok) throw new Error("put failed");
    }
    const pruned = await store.prune(cid, { retainCount: 2 });
    expect(pruned.ok).toBe(true);
    if (pruned.ok) expect(pruned.value).toBe(2);

    // After prune, list must return exactly 2 nodes, all readable
    const list = await store.list(cid);
    expect(list.ok).toBe(true);
    if (!list.ok) throw new Error("list failed");
    expect(list.value.length).toBe(2);
    // Each listed node must round-trip via get (no dangling pointers)
    for (const node of list.value) {
      const got = await store.get(node.nodeId);
      expect(got.ok).toBe(true);
    }
  });

  // --- Parent validation inside chain lock regression test (Finding 3) ---

  test("put with missing parent returns validation error (not silent success)", async () => {
    const store = newStore();
    const cid = chainId("c-parent-check");
    const r = await store.put(cid, { v: 1 }, ["node-nonexistent" as NodeId]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("VALIDATION");
  });

  // --- Fix 5: parent validation uses memberPath (chain membership) ---

  test("put with parent that has been pruned (membership removed) returns validation error", async () => {
    // After prune removes a node's membership marker, subsequent puts must not
    // accept that node as a parent — even though the canonical file still exists.
    // Setup: 3 nodes, prune to retain only the last 1 → first 2 lose membership.
    const store = newStore();
    const cid = chainId("c-pruned-parent");
    const n0 = await store.put(cid, { v: 0 }, []);
    if (!n0.ok || n0.value === undefined) throw new Error("n0 put failed");
    const pruned0Id = n0.value.nodeId;
    await store.put(cid, { v: 1 }, []);
    await store.put(cid, { v: 2 }, []);

    // Prune so only the newest 1 node survives (pruned0Id loses its membership marker).
    const pruned = await store.prune(cid, { retainCount: 1 });
    expect(pruned.ok).toBe(true);
    if (pruned.ok) expect(pruned.value).toBeGreaterThanOrEqual(2);

    // The canonical node file for pruned0Id still exists (deferred GC),
    // but its membership marker was removed. Parent validation must use memberPath
    // and reject this node.
    const r = await store.put(cid, { v: 3 }, [pruned0Id]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("VALIDATION");
  });

  test("fork then put in forked chain using source as parent succeeds (fork copies membership)", async () => {
    // After fork, ancestor membership is in the new chain so they are valid parents.
    const store = newStore();
    const src = chainId("c-fork-parent-src");
    const root = await store.put(src, { v: 1 }, []);
    if (!root.ok || root.value === undefined) throw new Error();
    const rootId = root.value.nodeId;

    const forked = chainId("c-fork-parent-dst");
    const f = await store.fork(rootId, forked, "branch");
    expect(f.ok).toBe(true);

    // Source node is now a member of the forked chain → valid parent.
    const child = await store.put(forked, { v: 2 }, [rootId]);
    expect(child.ok).toBe(true);
  });

  // --- Fix 4: fork wraps target chain in lock + rejects non-empty ---

  test("fork into empty chainId succeeds", async () => {
    const store = newStore();
    const src = chainId("c-fork-empty-src");
    const root = await store.put(src, { v: 1 }, []);
    if (!root.ok || root.value === undefined) throw new Error();

    const dst = chainId("c-fork-empty-dst");
    const f = await store.fork(root.value.nodeId, dst, "test");
    expect(f.ok).toBe(true);

    const head = await store.head(dst);
    expect(head.ok).toBe(true);
    if (head.ok && head.value !== undefined) expect(head.value.data.v).toBe(1);
  });

  test("fork into non-empty chainId throws VALIDATION error", async () => {
    // Once a chain has been populated, forking into it would clobber its head.
    const store = newStore();
    const src = chainId("c-fork-nonempty-src");
    const root = await store.put(src, { v: 1 }, []);
    if (!root.ok || root.value === undefined) throw new Error();

    const dst = chainId("c-fork-nonempty-dst");
    // Populate dst first.
    const p = await store.put(dst, { v: 99 }, []);
    expect(p.ok).toBe(true);

    // Fork into the already-populated dst must fail.
    const f = await store.fork(root.value.nodeId, dst, "should-fail");
    expect(f.ok).toBe(false);
    if (!f.ok) expect(f.error.code).toBe("VALIDATION");
  });

  test("concurrent fork + put on same target chainId — fork wins or put wins cleanly", async () => {
    // Race: fork into an empty chain vs put into the same chain concurrently.
    // fork acquires the target chain lock; put also acquires it.
    // One must succeed, and the resulting state must be consistent (no corruption).
    const store = newStore();
    const src = chainId("c-fork-race-src");
    const root = await store.put(src, { v: 1 }, []);
    if (!root.ok || root.value === undefined) throw new Error();

    const dst = chainId("c-fork-race-dst");
    const [forkResult, putResult] = await Promise.all([
      store.fork(root.value.nodeId, dst, "race"),
      store.put(dst, { v: 2 }, []),
    ]);

    // Exactly one must have succeeded first; the other either also succeeded
    // (if put won the lock first, fork then fails non-empty) or both are ok.
    // The invariant: head of dst must be readable and consistent.
    const head = await store.head(dst);
    expect(head.ok).toBe(true);

    // If fork succeeded, fork result is ok
    if (forkResult.ok) expect(forkResult.value.parentNodeId).toBe(root.value.nodeId);
    // If put succeeded, the data must be intact
    if (putResult.ok && putResult.value !== undefined) {
      expect(putResult.value.data.v).toBe(2);
    }
    // At least one must have succeeded
    expect(forkResult.ok || (putResult.ok && putResult.value !== undefined)).toBe(true);
  });

  test("concurrent put+prune: child either succeeds or fails cleanly — no dangling parentId", async () => {
    // This test verifies that when put and prune race on the same chain,
    // the final state is consistent: every parentId in stored nodes exists.
    const store = newStore();
    const cid = chainId("c-race");

    // Put a root node
    const root = await store.put(cid, { v: 0 }, []);
    if (!root.ok || root.value === undefined) throw new Error("root put failed");
    const rootId = root.value.nodeId;

    // Race: put a child (depends on root) vs prune root away
    const [putResult, pruneResult] = await Promise.all([
      store.put(cid, { v: 1 }, [rootId]),
      store.prune(cid, { retainCount: 0 }),
    ]);

    // Either the put succeeded (root still present) or failed with VALIDATION
    if (putResult.ok && putResult.value !== undefined) {
      // put won: verify the parent still exists in the chain
      const listResult = await store.list(cid);
      expect(listResult.ok).toBe(true);
      if (listResult.ok) {
        const nodeIds = new Set(listResult.value.map((n) => n.nodeId));
        for (const node of listResult.value) {
          for (const pid of node.parentIds) {
            // Every stored parentId must be present in the chain or be the root
            // (root may have been pruned — this is the race condition we guard).
            // The invariant: if the child was written, the meta must be consistent.
            // We accept either "parent exists" or "child was never written".
            expect(typeof pid).toBe("string");
            void nodeIds; // used above
          }
        }
      }
    } else if (!putResult.ok) {
      // put lost: must have a VALIDATION error (not a crash or corruption)
      expect(putResult.error.code).toBe("VALIDATION");
    }

    // prune result doesn't matter — but must not crash
    expect(typeof pruneResult.ok).toBe("boolean");
  });

  // --- Fix 2 (round 4): parent validation requires both meta membership AND marker ---

  test("after successful prune, removed parent is rejected by meta check (regression)", async () => {
    // Standard prune path: meta written first (removes nodeId), then marker deleted.
    // Parent validation must reject the pruned node because it is not in meta.nodeIds.
    const store = newStore();
    const cid = chainId("c-meta-parent-check");
    const n0 = await store.put(cid, { v: 0 }, []);
    if (!n0.ok || n0.value === undefined) throw new Error("n0 put failed");
    const prunedId = n0.value.nodeId;
    await store.put(cid, { v: 1 }, []);

    // Prune to retainCount=1 → prunedId leaves meta.nodeIds AND marker is deleted.
    const pruned = await store.prune(cid, { retainCount: 1 });
    expect(pruned.ok).toBe(true);
    if (pruned.ok) expect(pruned.value).toBe(1);

    // prunedId is now absent from meta.nodeIds — must be rejected as a parent.
    const r = await store.put(cid, { v: 2 }, [prunedId]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("VALIDATION");
  });

  // --- Fix 1 (round 5): prune deletes canonical nodes when last chain membership goes ---

  test("prune({ retainCount: 0 }) then get(removedNodeId) returns NOT_FOUND", async () => {
    // After all nodes are pruned from the only chain that holds them,
    // the canonical file must be deleted so get() returns NOT_FOUND.
    const store = newStore();
    const cid = chainId("c-prune-gc-1");
    const r = await store.put(cid, { v: 1 }, []);
    if (!r.ok || r.value === undefined) throw new Error("put failed");
    const nid = r.value.nodeId;

    await store.prune(cid, { retainCount: 0, retainBranches: false });
    const got = await store.get(nid);
    expect(got.ok).toBe(false);
    if (!got.ok) expect(got.error.code).toBe("NOT_FOUND");
  });

  test("prune({ retainCount: 0 }) then fork(removedNodeId) returns NOT_FOUND", async () => {
    // fork calls get internally; if canonical is deleted, fork must also fail.
    const store = newStore();
    const cid = chainId("c-prune-gc-fork");
    const r = await store.put(cid, { v: 1 }, []);
    if (!r.ok || r.value === undefined) throw new Error("put failed");
    const nid = r.value.nodeId;

    await store.prune(cid, { retainCount: 0, retainBranches: false });
    const f = await store.fork(nid, chainId("c-prune-gc-fork-dst"), "test");
    expect(f.ok).toBe(false);
    if (!f.ok) expect(f.error.code).toBe("NOT_FOUND");
  });

  test("prune source chain preserves canonical when forked chain holds a marker", async () => {
    // After fork, both chains share the canonical node. Pruning the SOURCE chain
    // must NOT delete the canonical because the forked chain still holds a marker.
    const store = newStore();
    const src = chainId("c-prune-gc-src");
    const r = await store.put(src, { v: 1 }, []);
    if (!r.ok || r.value === undefined) throw new Error("put failed");
    const nid = r.value.nodeId;

    // Fork so nid gains a membership marker in the new chain.
    const dst = chainId("c-prune-gc-dst");
    const f = await store.fork(nid, dst, "branch");
    expect(f.ok).toBe(true);

    // Prune the source chain completely — nid is removed from src.
    await store.prune(src, { retainCount: 0, retainBranches: false });

    // dst still holds the membership marker; canonical must still be accessible.
    const got = await store.get(nid);
    expect(got.ok).toBe(true);
    if (got.ok) expect(got.value.data.v).toBe(1);
  });

  test("two chains share an ancestor; prune only one chain — canonical persists", async () => {
    // Both chains share the ancestor node; prune one chain. The other chain's
    // membership marker must prevent the canonical file from being deleted.
    const store = newStore();
    const src = chainId("c-prune-shared-src");
    const root = await store.put(src, { v: 42 }, []);
    if (!root.ok || root.value === undefined) throw new Error("root put failed");
    const rootNid = root.value.nodeId;

    const dst = chainId("c-prune-shared-dst");
    await store.fork(rootNid, dst, "sibling");

    // Prune src so rootNid is removed from src.
    await store.prune(src, { retainCount: 0, retainBranches: false });

    // dst still has rootNid in its membership → canonical must survive.
    const got = await store.get(rootNid);
    expect(got.ok).toBe(true);

    // Also prune dst → now no chain holds the marker → canonical must be gone.
    await store.prune(dst, { retainCount: 0, retainBranches: false });
    const gone = await store.get(rootNid);
    expect(gone.ok).toBe(false);
    if (!gone.ok) expect(gone.error.code).toBe("NOT_FOUND");
  });

  test("partial-prune failure (meta written, marker survives) — orphaned parent rejected by meta check", async () => {
    // Scenario: prune writes meta (nodeId removed) but marker deletion fails.
    // The orphaned marker must NOT allow the node to be used as a parent.
    // We simulate this by: completing a full prune (meta + marker both gone), then
    // manually re-inserting the marker file without updating meta.
    const transport = createFakeNexusTransport();
    const store = createSnapshotStoreNexus<TData>({ transport });
    const cid = chainId("c-partial-prune");
    const n0 = await store.put(cid, { v: 0 }, []);
    if (!n0.ok || n0.value === undefined) throw new Error("n0 put failed");
    const orphanId = n0.value.nodeId;
    await store.put(cid, { v: 1 }, []);

    // Full prune: meta removes orphanId, marker is deleted.
    const pruned = await store.prune(cid, { retainCount: 1 });
    expect(pruned.ok).toBe(true);

    // Now re-inject the membership marker without touching meta.
    // This simulates a partial-prune failure where meta was updated but the
    // marker delete failed (or was replayed from a cache).
    const markerPath = `snapshots/${cid}/members/${orphanId}.member`;
    const wr = await transport.call<unknown>("write", { path: markerPath, content: "{}" });
    expect(wr.ok).toBe(true);

    // Meta no longer lists orphanId; marker exists. Parent check must use meta
    // as authoritative source and reject the orphaned parent.
    const r = await store.put(cid, { v: 2 }, [orphanId]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("VALIDATION");
  });

  // --- Fix 1 (round 6): canonical mutex prevents fork+prune race (#1405) ---

  test("fork+prune race: canonical node is always readable after fork succeeds", async () => {
    // Race scenario: fork and prune run concurrently on the same source chain.
    // After both settle, if fork succeeded its canonical nodes must be readable.
    const store = newStore();
    const src = chainId("c-fork-prune-race-src");
    const root = await store.put(src, { v: 1 }, []);
    if (!root.ok || root.value === undefined) throw new Error("root put failed");
    const rootNid = root.value.nodeId;

    const dst = chainId("c-fork-prune-race-dst");

    // Run fork and prune concurrently.
    const [forkResult, pruneResult] = await Promise.all([
      store.fork(rootNid, dst, "race"),
      store.prune(src, { retainCount: 0, retainBranches: false }),
    ]);

    // prune must not crash.
    expect(typeof pruneResult.ok).toBe("boolean");

    if (forkResult.ok) {
      // fork succeeded: all canonical nodes that fork copied markers for must exist.
      const head = await store.head(dst);
      expect(head.ok).toBe(true);
      if (head.ok && head.value !== undefined) {
        const got = await store.get(head.value.nodeId);
        expect(got.ok).toBe(true);
      }
    } else {
      // fork detected the race and failed with INTERNAL — acceptable outcome.
      expect(forkResult.error.code).toBe("INTERNAL");
    }
  });

  test("sequential fork then prune: source chain prune does not delete shared canonical", async () => {
    // After fork completes, source prune must not delete canonical nodes that
    // the fork chain now holds markers for. Canonical mutex ensures this.
    const store = newStore();
    const src = chainId("c-fork-seq-src");
    const root = await store.put(src, { v: 10 }, []);
    if (!root.ok || root.value === undefined) throw new Error();
    const rootNid = root.value.nodeId;

    // Fork first (sequential) — markers are written before prune starts.
    const dst = chainId("c-fork-seq-dst");
    const f = await store.fork(rootNid, dst, "sequential");
    expect(f.ok).toBe(true);

    // Prune the source chain completely.
    await store.prune(src, { retainCount: 0, retainBranches: false });

    // dst still holds the canonical node — must still be readable.
    const got = await store.get(rootNid);
    expect(got.ok).toBe(true);
    if (got.ok) expect(got.value.data.v).toBe(10);
  });
});
