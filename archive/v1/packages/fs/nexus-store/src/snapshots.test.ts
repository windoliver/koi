/**
 * Tests for the Nexus-backed SnapshotChainStore in @koi/nexus-store.
 *
 * Uses the contract test suite from @koi/test-utils, plus Nexus-specific
 * tests for path layout, content hash dedup, and error handling.
 */

import { describe, expect, test } from "bun:test";
import type { ChainId, NodeId } from "@koi/core";
import { createFakeNexusFetch, runSnapshotChainStoreContractTests } from "@koi/test-utils";
import { createNexusSnapshotStore } from "./snapshots.js";

// ---------------------------------------------------------------------------
// Contract test suite
// ---------------------------------------------------------------------------

interface TestData {
  readonly name: string;
  readonly value: number;
}

let dataCounter = 0;

runSnapshotChainStoreContractTests<TestData>(
  () =>
    createNexusSnapshotStore<TestData>({
      baseUrl: "http://fake-nexus",
      apiKey: "test-key",
      fetch: createFakeNexusFetch(),
    }),
  () => ({ name: `data-${++dataCounter}`, value: dataCounter }),
  () => ({ name: `different-${++dataCounter}`, value: dataCounter + 1000 }),
);

// ---------------------------------------------------------------------------
// Nexus-specific tests
// ---------------------------------------------------------------------------

describe("createNexusSnapshotStore — nexus-specific", () => {
  function createStore(): ReturnType<typeof createNexusSnapshotStore<TestData>> {
    return createNexusSnapshotStore<TestData>({
      baseUrl: "http://fake-nexus",
      apiKey: "test-key",
      fetch: createFakeNexusFetch(),
    });
  }

  test("put and head round-trip", async () => {
    const store = createStore();
    const cid = "chain-1" as ChainId;

    const putResult = await store.put(cid, { name: "first", value: 1 }, []);
    expect(putResult.ok).toBe(true);

    const headResult = await store.head(cid);
    expect(headResult.ok).toBe(true);
    if (headResult.ok && headResult.value !== undefined) {
      expect(headResult.value.data).toEqual({ name: "first", value: 1 });
    }

    store.close();
  });

  test("skipIfUnchanged deduplicates identical data", async () => {
    const store = createStore();
    const cid = "chain-dedup" as ChainId;

    const r1 = await store.put(cid, { name: "same", value: 42 }, []);
    expect(r1.ok).toBe(true);

    const r2 = await store.put(cid, { name: "same", value: 42 }, [], undefined, {
      skipIfUnchanged: true,
    });
    expect(r2.ok).toBe(true);
    if (r2.ok) {
      expect(r2.value).toBeUndefined();
    }

    const listResult = await store.list(cid);
    expect(listResult.ok).toBe(true);
    if (listResult.ok) {
      expect(listResult.value).toHaveLength(1);
    }

    store.close();
  });

  test("ancestor walking through parent chain", async () => {
    const store = createStore();
    const cid = "chain-ancestors" as ChainId;

    const r1 = await store.put(cid, { name: "n1", value: 1 }, []);
    expect(r1.ok).toBe(true);

    let parentId: NodeId | undefined;
    if (r1.ok && r1.value !== undefined) {
      parentId = r1.value.nodeId;
    }
    expect(parentId).toBeDefined();

    const r2 = await store.put(cid, { name: "n2", value: 2 }, [parentId as NodeId]);
    expect(r2.ok).toBe(true);

    let lastId: NodeId | undefined;
    if (r2.ok && r2.value !== undefined) {
      lastId = r2.value.nodeId;
    }
    expect(lastId).toBeDefined();

    const ancestors = await store.ancestors({ startNodeId: lastId as NodeId });
    expect(ancestors.ok).toBe(true);
    if (ancestors.ok) {
      expect(ancestors.value).toHaveLength(2);
    }

    store.close();
  });

  test("fork creates new chain referencing source node", async () => {
    const store = createStore();
    const cid = "chain-fork" as ChainId;

    const r1 = await store.put(cid, { name: "root", value: 0 }, []);
    expect(r1.ok).toBe(true);

    let rootId: NodeId | undefined;
    if (r1.ok && r1.value !== undefined) {
      rootId = r1.value.nodeId;
    }
    expect(rootId).toBeDefined();

    const forkCid = "chain-forked" as ChainId;
    const forkResult = await store.fork(rootId as NodeId, forkCid, "test-fork");
    expect(forkResult.ok).toBe(true);

    const headResult = await store.head(forkCid);
    expect(headResult.ok).toBe(true);
    if (headResult.ok && headResult.value !== undefined && rootId !== undefined) {
      expect(headResult.value.nodeId).toBe(rootId);
    }

    store.close();
  });

  test("prune removes oldest nodes while keeping head", async () => {
    const store = createStore();
    const cid = "chain-prune" as ChainId;

    let lastId: NodeId | undefined;
    for (let i = 0; i < 5; i++) {
      const parents = lastId !== undefined ? [lastId] : [];
      const r = await store.put(cid, { name: `n${i}`, value: i }, parents);
      expect(r.ok).toBe(true);
      if (r.ok && r.value !== undefined) {
        lastId = r.value.nodeId;
      }
    }

    const pruneResult = await store.prune(cid, { retainCount: 2 });
    expect(pruneResult.ok).toBe(true);
    if (pruneResult.ok) {
      expect(pruneResult.value).toBe(3);
    }

    const listResult = await store.list(cid);
    expect(listResult.ok).toBe(true);
    if (listResult.ok) {
      expect(listResult.value).toHaveLength(2);
    }

    store.close();
  });

  test("custom basePath is respected", async () => {
    const calls: Array<{ readonly method: string; readonly path: string }> = [];
    const innerFetch = createFakeNexusFetch();

    const spyFetch = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      const body = JSON.parse(init?.body as string) as {
        readonly method: string;
        readonly params: Record<string, unknown>;
      };
      if (body.params.path !== undefined) {
        calls.push({ method: body.method, path: body.params.path as string });
      }
      return innerFetch(input, init);
    }) as typeof globalThis.fetch;

    const store = createNexusSnapshotStore<TestData>({
      baseUrl: "http://fake-nexus",
      apiKey: "test-key",
      fetch: spyFetch,
      basePath: "/custom/snapshots",
    });

    await store.put("c1" as ChainId, { name: "test", value: 1 }, []);

    const writeCalls = calls.filter((c) => c.method === "write");
    expect(writeCalls.some((c) => c.path.startsWith("/custom/snapshots/c1/"))).toBe(true);

    store.close();
  });

  test("handles Nexus errors gracefully", async () => {
    const failFetch = (async (
      _input: string | URL | Request,
      _init?: RequestInit,
    ): Promise<Response> => {
      throw new Error("Network failure");
    }) as typeof globalThis.fetch;

    const store = createNexusSnapshotStore<TestData>({
      baseUrl: "http://fake-nexus",
      apiKey: "test-key",
      fetch: failFetch,
    });

    const result = await store.put("c1" as ChainId, { name: "fail", value: 0 }, []);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.retryable).toBe(true);
    }

    store.close();
  });
});
