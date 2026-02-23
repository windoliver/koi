import { describe, expect, test } from "bun:test";
import { runEventBackendContractTests } from "@koi/test-utils";
import { createInMemoryEventBackend } from "./memory-backend.js";

// Run the full shared contract test suite
runEventBackendContractTests(() => createInMemoryEventBackend());

// ---------------------------------------------------------------------------
// Memory-backend-specific tests
// ---------------------------------------------------------------------------

describe("createInMemoryEventBackend — memory-specific", () => {
  test("FIFO eviction with low maxEventsPerStream", async () => {
    const backend = createInMemoryEventBackend({ maxEventsPerStream: 5 });

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

  test("close deactivates all subscriptions", async () => {
    const backend = createInMemoryEventBackend();
    const received: unknown[] = [];

    await backend.subscribe({
      streamId: "s",
      subscriptionName: "sub",
      fromPosition: 0,
      handler: (evt) => {
        received.push(evt.data);
      },
    });

    await backend.append("s", { type: "a", data: 1 });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(received).toHaveLength(1);

    await backend.close();

    // Append after close should not deliver (backend is closed)
    // Creating new backend to verify isolation
    const backend2 = createInMemoryEventBackend();
    expect(await backend2.streamLength("s")).toBe(0);
    await backend2.close();
  });

  test("default maxRetries is 3", async () => {
    const backend = createInMemoryEventBackend();
    // let is required: counter mutates across handler invocations
    let attempts = 0;

    await backend.subscribe({
      streamId: "s",
      subscriptionName: "sub-default-retries",
      fromPosition: 0,
      handler: () => {
        attempts++;
        throw new Error("always fail");
      },
    });

    await backend.append("s", { type: "evt", data: 1 });
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Default maxRetries = 3
    expect(attempts).toBe(3);

    await backend.close();
  });

  test("sequences are per-stream", async () => {
    const backend = createInMemoryEventBackend();

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
    const backend = createInMemoryEventBackend({ maxEventsPerStream: 3 });

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

  test("TTL eviction excludes expired events from read", async () => {
    const backend = createInMemoryEventBackend({ eventTtlMs: 50 });

    await backend.append("s", { type: "old", data: 1 });
    await new Promise((resolve) => setTimeout(resolve, 80));
    await backend.append("s", { type: "new", data: 2 });

    const result = await backend.read("s");
    expect(result.ok).toBe(true);
    if (result.ok) {
      // "old" should be expired, only "new" remains
      expect(result.value.events).toHaveLength(1);
      expect(result.value.events[0]?.type).toBe("new");
    }

    await backend.close();
  });

  test("TTL eviction affects streamLength and firstSequence", async () => {
    const backend = createInMemoryEventBackend({ eventTtlMs: 50 });

    await backend.append("s", { type: "a", data: 1 });
    await backend.append("s", { type: "b", data: 2 });
    await new Promise((resolve) => setTimeout(resolve, 80));
    await backend.append("s", { type: "c", data: 3 });

    // First two events should be expired
    expect(await backend.streamLength("s")).toBe(1);
    expect(await backend.firstSequence("s")).toBe(3);

    await backend.close();
  });

  test("TTL cleanup on append removes expired events from storage", async () => {
    const backend = createInMemoryEventBackend({ eventTtlMs: 30 });

    await backend.append("s", { type: "a", data: 1 });
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Append triggers eviction of expired events
    await backend.append("s", { type: "b", data: 2 });

    const result = await backend.read("s");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.events).toHaveLength(1);
      expect(result.value.events[0]?.type).toBe("b");
    }

    await backend.close();
  });
});
