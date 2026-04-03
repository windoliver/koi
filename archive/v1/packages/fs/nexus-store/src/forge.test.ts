/**
 * Tests for the Nexus-backed ForgeStore in @koi/nexus-store.
 *
 * Uses the contract test suite from @koi/test-utils against a fake Nexus
 * JSON-RPC server, plus Nexus-specific tests for path layout, bounded
 * concurrency, error handling, and watch behavior.
 */

import { describe, expect, test } from "bun:test";
import type { StoreChangeEvent } from "@koi/core";
import { brickId } from "@koi/core";
import {
  createFakeNexusFetch,
  createTestToolArtifact,
  runForgeStoreContractTests,
} from "@koi/test-utils";
import { createNexusForgeStore } from "./forge.js";

// ---------------------------------------------------------------------------
// Contract tests — fake Nexus fetch
// ---------------------------------------------------------------------------

runForgeStoreContractTests(() =>
  createNexusForgeStore({
    baseUrl: "http://fake-nexus",
    apiKey: "test-key",
    fetch: createFakeNexusFetch(),
  }),
);

// ---------------------------------------------------------------------------
// Nexus-specific tests
// ---------------------------------------------------------------------------

describe("createNexusForgeStore — nexus-specific", () => {
  function createStore(overrides?: {
    readonly concurrency?: number;
  }): ReturnType<typeof createNexusForgeStore> {
    return createNexusForgeStore({
      baseUrl: "http://fake-nexus",
      apiKey: "test-key",
      fetch: createFakeNexusFetch(),
      ...(overrides?.concurrency !== undefined && { concurrency: overrides.concurrency }),
    });
  }

  test("stores bricks at correct path", async () => {
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
      calls.push({ method: body.method, path: body.params.path as string });
      return innerFetch(input, init);
    }) as typeof globalThis.fetch;

    const store = createNexusForgeStore({
      baseUrl: "http://fake-nexus",
      apiKey: "test-key",
      fetch: spyFetch,
      basePath: "/custom/bricks",
    });

    const brick = createTestToolArtifact({ id: brickId("brick_path_test") });
    await store.save(brick);

    const writeCalls = calls.filter((c) => c.method === "write");
    expect(writeCalls.length).toBe(1);
    expect(writeCalls[0]?.path).toBe("/custom/bricks/brick_path_test.json");
  });

  test("bounded concurrency limits parallel reads", async () => {
    // let justified: track concurrency across async reads
    let maxConcurrent = 0;
    let currentConcurrent = 0;
    const innerFetch = createFakeNexusFetch();

    const slowFetch = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      const body = JSON.parse(init?.body as string) as { readonly method: string };
      if (body.method === "read") {
        currentConcurrent += 1;
        if (currentConcurrent > maxConcurrent) {
          maxConcurrent = currentConcurrent;
        }
        await Bun.sleep(1);
        const result = await innerFetch(input, init);
        currentConcurrent -= 1;
        return result;
      }
      return innerFetch(input, init);
    }) as typeof globalThis.fetch;

    const store = createNexusForgeStore({
      baseUrl: "http://fake-nexus",
      apiKey: "test-key",
      fetch: slowFetch,
      concurrency: 3,
    });

    for (let i = 0; i < 9; i++) {
      await store.save(createTestToolArtifact({ id: brickId(`brick_conc_${i}`) }));
    }

    const result = await store.search({});
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.length).toBe(9);
    }
    expect(maxConcurrent).toBeLessThanOrEqual(3);
  });

  test("handles Nexus errors gracefully", async () => {
    const failFetch = (async (
      _input: string | URL | Request,
      _init?: RequestInit,
    ): Promise<Response> => {
      throw new Error("Network failure");
    }) as typeof globalThis.fetch;

    const store = createNexusForgeStore({
      baseUrl: "http://fake-nexus",
      apiKey: "test-key",
      fetch: failFetch,
    });

    const brick = createTestToolArtifact({ id: brickId("brick_fail") });
    const result = await store.save(brick);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.retryable).toBe(true);
    }
  });

  test("watch fires for local mutations", async () => {
    const store = createStore();
    const events: StoreChangeEvent[] = [];
    expect(store.watch).toBeDefined();
    store.watch?.((event) => {
      events.push(event);
    });

    const brick = createTestToolArtifact({ id: brickId("brick_watch") });
    await store.save(brick);
    await store.update(brickId("brick_watch"), { usageCount: 5 });
    await store.remove(brickId("brick_watch"));

    await Bun.sleep(10);
    expect(events).toHaveLength(3);
    expect(events[0]?.kind).toBe("saved");
    expect(events[1]?.kind).toBe("updated");
    expect(events[2]?.kind).toBe("removed");
  });

  test("dispose clears change listeners", async () => {
    const store = createStore();
    const events: StoreChangeEvent[] = [];
    expect(store.watch).toBeDefined();
    store.watch?.((event) => {
      events.push(event);
    });

    await store.save(createTestToolArtifact({ id: brickId("brick_disp1") }));
    expect(events).toHaveLength(1);

    store.dispose?.();

    await store.save(createTestToolArtifact({ id: brickId("brick_disp2") }));
    expect(events).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Optimistic locking — Issue 1A
// ---------------------------------------------------------------------------

describe("createNexusForgeStore — optimistic locking", () => {
  function createStore(): ReturnType<typeof createNexusForgeStore> {
    return createNexusForgeStore({
      baseUrl: "http://fake-nexus",
      apiKey: "test-key",
      fetch: createFakeNexusFetch(),
    });
  }

  test("update with correct expectedVersion succeeds", async () => {
    const store = createStore();
    const brick = createTestToolArtifact({ id: brickId("brick_olv1") });
    await store.save(brick);

    // After save, storeVersion is 1
    const updateResult = await store.update(brickId("brick_olv1"), {
      usageCount: 10,
      expectedVersion: 1,
    });
    expect(updateResult.ok).toBe(true);

    const loadResult = await store.load(brickId("brick_olv1"));
    expect(loadResult.ok).toBe(true);
    if (loadResult.ok) {
      expect(loadResult.value.storeVersion).toBe(2);
      expect(loadResult.value.usageCount).toBe(10);
    }
  });

  test("update with stale expectedVersion returns CONFLICT", async () => {
    const store = createStore();
    const brick = createTestToolArtifact({ id: brickId("brick_olv2") });
    await store.save(brick);

    // First update bumps version to 2
    await store.update(brickId("brick_olv2"), { usageCount: 5 });

    // Stale version (1) should fail
    const staleResult = await store.update(brickId("brick_olv2"), {
      usageCount: 99,
      expectedVersion: 1,
    });
    expect(staleResult.ok).toBe(false);
    if (!staleResult.ok) {
      expect(staleResult.error.code).toBe("CONFLICT");
      expect(staleResult.error.message).toContain("version");
    }
  });

  test("storeVersion survives JSON serialization roundtrip", async () => {
    const store = createStore();
    const brick = createTestToolArtifact({ id: brickId("brick_olv3") });
    await store.save(brick);

    const loadResult = await store.load(brickId("brick_olv3"));
    expect(loadResult.ok).toBe(true);
    if (loadResult.ok) {
      expect(typeof loadResult.value.storeVersion).toBe("number");
      expect(loadResult.value.storeVersion).toBe(1);
    }
  });

  test("update without expectedVersion succeeds unconditionally", async () => {
    const store = createStore();
    const brick = createTestToolArtifact({ id: brickId("brick_olv4") });
    await store.save(brick);

    // Two unconditional updates should both succeed
    const r1 = await store.update(brickId("brick_olv4"), { usageCount: 5 });
    expect(r1.ok).toBe(true);

    const r2 = await store.update(brickId("brick_olv4"), { usageCount: 10 });
    expect(r2.ok).toBe(true);

    const loadResult = await store.load(brickId("brick_olv4"));
    expect(loadResult.ok).toBe(true);
    if (loadResult.ok) {
      expect(loadResult.value.usageCount).toBe(10);
      expect(loadResult.value.storeVersion).toBe(3); // 1 (save) + 2 (updates)
    }
  });
});
