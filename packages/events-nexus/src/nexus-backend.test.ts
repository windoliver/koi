import { describe, expect, test } from "bun:test";
import { runEventBackendContractTests } from "@koi/test-utils";
import { createFakeNexusFetch } from "./fake-nexus-fetch.js";
import { createNexusEventBackend } from "./nexus-backend.js";

// ---------------------------------------------------------------------------
// Contract test suite — shared across all EventBackend implementations
// ---------------------------------------------------------------------------

runEventBackendContractTests(() =>
  createNexusEventBackend({
    baseUrl: "http://fake-nexus:2026",
    apiKey: "test-key",
    fetch: createFakeNexusFetch(),
  }),
);

// ---------------------------------------------------------------------------
// Nexus-backend-specific tests
// ---------------------------------------------------------------------------

describe("createNexusEventBackend — nexus-specific", () => {
  function createBackend(overrides?: {
    readonly maxEventsPerStream?: number;
    readonly eventTtlMs?: number;
  }) {
    return createNexusEventBackend({
      baseUrl: "http://fake-nexus:2026",
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

    // Only 5 events should remain
    expect(await backend.streamLength("s")).toBe(5);

    // Oldest events (1-3) should be evicted, leaving 4-8
    const result = await backend.read("s");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.events).toHaveLength(5);
      expect(result.value.events[0]?.data).toBe(4);
      expect(result.value.events[4]?.data).toBe(8);
    }

    await backend.close();
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

    await backend.close();
  });

  test("TTL eviction affects streamLength and firstSequence", async () => {
    const backend = createBackend({ eventTtlMs: 50 });

    await backend.append("s", { type: "a", data: 1 });
    await backend.append("s", { type: "b", data: 2 });
    await new Promise((resolve) => setTimeout(resolve, 80));
    await backend.append("s", { type: "c", data: 3 });

    // First two events should be expired
    expect(await backend.streamLength("s")).toBe(1);
    expect(await backend.firstSequence("s")).toBe(3);

    await backend.close();
  });

  // -------------------------------------------------------------------------
  // expectedSequence — optimistic concurrency control
  // -------------------------------------------------------------------------

  test("append with correct expectedSequence succeeds", async () => {
    const backend = createBackend();

    const r1 = await backend.append("s", { type: "a", data: 1 });
    expect(r1.ok).toBe(true);

    const r2 = await backend.append("s", { type: "b", data: 2, expectedSequence: 1 });
    expect(r2.ok).toBe(true);
    if (r2.ok) {
      expect(r2.value.sequence).toBe(2);
    }

    await backend.close();
  });

  test("append with wrong expectedSequence returns CONFLICT", async () => {
    const backend = createBackend();

    await backend.append("s", { type: "a", data: 1 });

    const result = await backend.append("s", { type: "b", data: 2, expectedSequence: 0 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("CONFLICT");
    }

    await backend.close();
  });

  test("expectedSequence 0 on empty stream succeeds", async () => {
    const backend = createBackend();

    const result = await backend.append("fresh", { type: "a", data: 1, expectedSequence: 0 });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.sequence).toBe(1);
    }

    await backend.close();
  });

  test("expectedSequence 0 on non-empty stream returns CONFLICT", async () => {
    const backend = createBackend();

    await backend.append("s", { type: "a", data: 1 });

    const result = await backend.append("s", { type: "b", data: 2, expectedSequence: 0 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("CONFLICT");
      expect(result.error.message).toContain("sequence mismatch");
    }

    await backend.close();
  });

  test("sequences are per-stream", async () => {
    const backend = createBackend();

    const r1 = await backend.append("stream-a", { type: "e", data: 1 });
    const r2 = await backend.append("stream-b", { type: "e", data: 2 });

    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    if (r1.ok && r2.ok) {
      expect(r1.value.sequence).toBe(1);
      expect(r2.value.sequence).toBe(1); // independent counter
    }

    await backend.close();
  });

  test("firstSequence reflects FIFO eviction", async () => {
    const backend = createBackend({ maxEventsPerStream: 3 });

    await backend.append("s", { type: "a", data: 1 });
    await backend.append("s", { type: "b", data: 2 });
    await backend.append("s", { type: "c", data: 3 });
    expect(await backend.firstSequence("s")).toBe(1);

    // Push past capacity — seq 1 evicted
    await backend.append("s", { type: "d", data: 4 });
    expect(await backend.firstSequence("s")).toBe(2);
    expect(await backend.streamLength("s")).toBe(3);

    await backend.close();
  });

  test("network error handling (fetch throws)", async () => {
    const failingFetch = (() => {
      throw new Error("network down");
    }) as unknown as typeof globalThis.fetch;

    const backend = createNexusEventBackend({
      baseUrl: "http://fake-nexus:2026",
      apiKey: "test-key",
      fetch: failingFetch,
    });

    const result = await backend.append("s", { type: "a", data: 1 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("EXTERNAL");
    }

    await backend.close();
  });
});
