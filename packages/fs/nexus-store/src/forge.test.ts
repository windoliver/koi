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
