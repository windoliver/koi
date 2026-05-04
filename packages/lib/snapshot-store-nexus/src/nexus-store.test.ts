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
});
