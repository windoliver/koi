/**
 * Tests for the Nexus-backed EventBackend in @koi/nexus-store.
 *
 * Uses the contract test suite from @koi/test-utils, plus Nexus-specific
 * tests for deferred eviction, TTL, optimistic concurrency, and error handling.
 */

import { describe, expect, test } from "bun:test";
import { createFakeNexusFetch, runEventBackendContractTests } from "@koi/test-utils";
import { createNexusEventBackend } from "./events.js";

// ---------------------------------------------------------------------------
// Contract test suite
// ---------------------------------------------------------------------------

runEventBackendContractTests(() =>
  createNexusEventBackend({
    baseUrl: "http://fake-nexus",
    apiKey: "test-key",
    fetch: createFakeNexusFetch(),
  }),
);

// ---------------------------------------------------------------------------
// Nexus-specific tests
// ---------------------------------------------------------------------------

describe("createNexusEventBackend — nexus-specific", () => {
  function createBackend(overrides?: {
    readonly maxEventsPerStream?: number;
    readonly eventTtlMs?: number;
  }): ReturnType<typeof createNexusEventBackend> {
    return createNexusEventBackend({
      baseUrl: "http://fake-nexus",
      apiKey: "test-key",
      fetch: createFakeNexusFetch(),
      ...overrides,
    });
  }

  test("FIFO eviction with low maxEventsPerStream", async () => {
    const backend = createBackend({ maxEventsPerStream: 5 });

    for (let i = 1; i <= 8; i++) {
      await backend.append("s", { type: "evt", data: i });
    }

    expect(await backend.streamLength("s")).toBe(5);

    const result = await backend.read("s");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.events).toHaveLength(5);
      expect(result.value.events[0]?.data).toBe(4);
      expect(result.value.events[4]?.data).toBe(8);
    }

    backend.close();
  });

  test("TTL eviction excludes expired events from read", async () => {
    const backend = createBackend({ eventTtlMs: 50 });

    await backend.append("s", { type: "old", data: 1 });
    await new Promise((resolve) => setTimeout(resolve, 80));
    await backend.append("s", { type: "new", data: 2 });

    const result = await backend.read("s");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.events).toHaveLength(1);
      expect(result.value.events[0]?.type).toBe("new");
    }

    backend.close();
  });

  test("TTL eviction affects streamLength and firstSequence", async () => {
    const backend = createBackend({ eventTtlMs: 50 });

    await backend.append("s", { type: "a", data: 1 });
    await backend.append("s", { type: "b", data: 2 });
    await new Promise((resolve) => setTimeout(resolve, 80));
    await backend.append("s", { type: "c", data: 3 });

    expect(await backend.streamLength("s")).toBe(1);
    expect(await backend.firstSequence("s")).toBe(3);

    backend.close();
  });

  test("append with correct expectedSequence succeeds", async () => {
    const backend = createBackend();

    const r1 = await backend.append("s", { type: "a", data: 1 });
    expect(r1.ok).toBe(true);

    const r2 = await backend.append("s", { type: "b", data: 2, expectedSequence: 1 });
    expect(r2.ok).toBe(true);
    if (r2.ok) {
      expect(r2.value.sequence).toBe(2);
    }

    backend.close();
  });

  test("append with wrong expectedSequence returns CONFLICT", async () => {
    const backend = createBackend();

    await backend.append("s", { type: "a", data: 1 });

    const result = await backend.append("s", { type: "b", data: 2, expectedSequence: 0 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("CONFLICT");
    }

    backend.close();
  });

  test("sequences are per-stream", async () => {
    const backend = createBackend();

    const r1 = await backend.append("stream-a", { type: "e", data: 1 });
    const r2 = await backend.append("stream-b", { type: "e", data: 2 });

    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    if (r1.ok && r2.ok) {
      expect(r1.value.sequence).toBe(1);
      expect(r2.value.sequence).toBe(1);
    }

    backend.close();
  });

  test("firstSequence reflects FIFO eviction", async () => {
    const backend = createBackend({ maxEventsPerStream: 3 });

    await backend.append("s", { type: "a", data: 1 });
    await backend.append("s", { type: "b", data: 2 });
    await backend.append("s", { type: "c", data: 3 });
    expect(await backend.firstSequence("s")).toBe(1);

    await backend.append("s", { type: "d", data: 4 });
    expect(await backend.firstSequence("s")).toBe(2);
    expect(await backend.streamLength("s")).toBe(3);

    backend.close();
  });

  test("network error handling", async () => {
    const failingFetch = (() => {
      throw new Error("network down");
    }) as unknown as typeof globalThis.fetch;

    const backend = createNexusEventBackend({
      baseUrl: "http://fake-nexus",
      apiKey: "test-key",
      fetch: failingFetch,
    });

    const result = await backend.append("s", { type: "a", data: 1 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("EXTERNAL");
    }

    backend.close();
  });
});
