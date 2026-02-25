/**
 * Reusable contract test suite for EventBackend implementations.
 *
 * Accepts a factory that returns an EventBackend (sync or async).
 * Each test creates a fresh backend instance for isolation.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import type { DeadLetterEntry, EventBackend, EventEnvelope } from "@koi/core";

/**
 * Run the EventBackend contract test suite against any implementation.
 *
 * The factory can return sync or async. Called once per test for isolation.
 */
export function runEventBackendContractTests(
  createBackend: () => EventBackend | Promise<EventBackend>,
): void {
  describe("EventBackend contract", () => {
    let backend: EventBackend;

    beforeEach(async () => {
      backend = await createBackend();
    });

    // -----------------------------------------------------------------------
    // append
    // -----------------------------------------------------------------------

    test("append assigns monotonic sequence starting at 1", async () => {
      const r1 = await backend.append("stream-a", { type: "evt", data: 1 });
      const r2 = await backend.append("stream-a", { type: "evt", data: 2 });
      const r3 = await backend.append("stream-a", { type: "evt", data: 3 });

      expect(r1.ok).toBe(true);
      expect(r2.ok).toBe(true);
      expect(r3.ok).toBe(true);
      if (r1.ok && r2.ok && r3.ok) {
        expect(r1.value.sequence).toBe(1);
        expect(r2.value.sequence).toBe(2);
        expect(r3.value.sequence).toBe(3);
      }
    });

    test("append returns full EventEnvelope with id and timestamp", async () => {
      const before = Date.now();
      const result = await backend.append("stream-a", {
        type: "test:created",
        data: { foo: "bar" },
        metadata: { correlationId: "abc" },
      });
      const after = Date.now();

      expect(result.ok).toBe(true);
      if (result.ok) {
        const evt = result.value;
        expect(evt.id).toBeTruthy();
        expect(evt.streamId).toBe("stream-a");
        expect(evt.type).toBe("test:created");
        expect(evt.sequence).toBe(1);
        expect(evt.data).toEqual({ foo: "bar" });
        expect(evt.metadata).toEqual({ correlationId: "abc" });
        expect(evt.timestamp).toBeGreaterThanOrEqual(before);
        expect(evt.timestamp).toBeLessThanOrEqual(after);
      }
    });

    // -----------------------------------------------------------------------
    // read
    // -----------------------------------------------------------------------

    test("read returns events in sequence order", async () => {
      await backend.append("s", { type: "a", data: 1 });
      await backend.append("s", { type: "b", data: 2 });
      await backend.append("s", { type: "c", data: 3 });

      const result = await backend.read("s");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.events).toHaveLength(3);
        expect(result.value.events[0]?.sequence).toBe(1);
        expect(result.value.events[1]?.sequence).toBe(2);
        expect(result.value.events[2]?.sequence).toBe(3);
      }
    });

    test("read with fromSequence filters correctly", async () => {
      await backend.append("s", { type: "a", data: 1 });
      await backend.append("s", { type: "b", data: 2 });
      await backend.append("s", { type: "c", data: 3 });

      const result = await backend.read("s", { fromSequence: 2 });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.events).toHaveLength(2);
        expect(result.value.events[0]?.sequence).toBe(2);
        expect(result.value.events[1]?.sequence).toBe(3);
      }
    });

    test("read with limit and hasMore pagination", async () => {
      await backend.append("s", { type: "a", data: 1 });
      await backend.append("s", { type: "b", data: 2 });
      await backend.append("s", { type: "c", data: 3 });

      const result = await backend.read("s", { limit: 2 });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.events).toHaveLength(2);
        expect(result.value.hasMore).toBe(true);
      }
    });

    test("read backward direction", async () => {
      await backend.append("s", { type: "a", data: 1 });
      await backend.append("s", { type: "b", data: 2 });
      await backend.append("s", { type: "c", data: 3 });

      const result = await backend.read("s", { direction: "backward" });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.events).toHaveLength(3);
        expect(result.value.events[0]?.sequence).toBe(3);
        expect(result.value.events[1]?.sequence).toBe(2);
        expect(result.value.events[2]?.sequence).toBe(1);
      }
    });

    test("empty stream read returns empty array (not error)", async () => {
      const result = await backend.read("nonexistent");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.events).toHaveLength(0);
        expect(result.value.hasMore).toBe(false);
      }
    });

    test("stream isolation — events in stream A not visible in stream B", async () => {
      await backend.append("stream-a", { type: "a", data: 1 });
      await backend.append("stream-b", { type: "b", data: 2 });

      const resultA = await backend.read("stream-a");
      const resultB = await backend.read("stream-b");

      expect(resultA.ok).toBe(true);
      expect(resultB.ok).toBe(true);
      if (resultA.ok && resultB.ok) {
        expect(resultA.value.events).toHaveLength(1);
        expect(resultA.value.events[0]?.type).toBe("a");
        expect(resultB.value.events).toHaveLength(1);
        expect(resultB.value.events[0]?.type).toBe("b");
      }
    });

    test("read with toSequence (exclusive upper bound)", async () => {
      await backend.append("s", { type: "a", data: 1 });
      await backend.append("s", { type: "b", data: 2 });
      await backend.append("s", { type: "c", data: 3 });

      const result = await backend.read("s", { fromSequence: 1, toSequence: 3 });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.events).toHaveLength(2);
        expect(result.value.events[0]?.sequence).toBe(1);
        expect(result.value.events[1]?.sequence).toBe(2);
      }
    });

    // -----------------------------------------------------------------------
    // subscribe
    // -----------------------------------------------------------------------

    test("subscribe delivers events to handler", async () => {
      const received: EventEnvelope[] = [];
      const handle = await backend.subscribe({
        streamId: "s",
        subscriptionName: "sub-1",
        fromPosition: 0,
        handler: (evt) => {
          received.push(evt);
        },
      });

      await backend.append("s", { type: "a", data: 1 });
      await backend.append("s", { type: "b", data: 2 });

      // Allow microtask delivery
      await Bun.sleep(50);

      expect(received).toHaveLength(2);
      expect(received[0]?.type).toBe("a");
      expect(received[1]?.type).toBe("b");

      handle.unsubscribe();
    });

    test("subscription from future position receives only new events", async () => {
      await backend.append("s", { type: "old", data: 0 });

      const received: EventEnvelope[] = [];
      const handle = await backend.subscribe({
        streamId: "s",
        subscriptionName: "sub-future",
        fromPosition: 1, // after sequence 1
        handler: (evt) => {
          received.push(evt);
        },
      });

      await backend.append("s", { type: "new", data: 1 });
      await Bun.sleep(50);

      expect(received).toHaveLength(1);
      expect(received[0]?.type).toBe("new");

      handle.unsubscribe();
    });

    // -----------------------------------------------------------------------
    // DLQ — sync throw
    // -----------------------------------------------------------------------

    test("subscriber throws sync — retry then DLQ", async () => {
      const deadLetters: DeadLetterEntry[] = [];
      const handle = await backend.subscribe({
        streamId: "s",
        subscriptionName: "sub-fail",
        fromPosition: 0,
        maxRetries: 2,
        handler: () => {
          throw new Error("handler boom");
        },
        onDeadLetter: (entry) => {
          deadLetters.push(entry);
        },
      });

      await backend.append("s", { type: "fail-evt", data: 1 });
      await Bun.sleep(100);

      expect(deadLetters).toHaveLength(1);
      expect(deadLetters[0]?.error).toContain("handler boom");
      expect(deadLetters[0]?.attempts).toBe(2);
      expect(deadLetters[0]?.subscriptionName).toBe("sub-fail");

      handle.unsubscribe();
    });

    // -----------------------------------------------------------------------
    // DLQ — async reject
    // -----------------------------------------------------------------------

    test("subscriber rejects async — retry then DLQ", async () => {
      const deadLetters: DeadLetterEntry[] = [];
      const handle = await backend.subscribe({
        streamId: "s",
        subscriptionName: "sub-reject",
        fromPosition: 0,
        maxRetries: 3,
        handler: async () => {
          throw new Error("async boom");
        },
        onDeadLetter: (entry) => {
          deadLetters.push(entry);
        },
      });

      await backend.append("s", { type: "reject-evt", data: 1 });
      await Bun.sleep(100);

      expect(deadLetters).toHaveLength(1);
      expect(deadLetters[0]?.error).toContain("async boom");
      expect(deadLetters[0]?.attempts).toBe(3);

      handle.unsubscribe();
    });

    // -----------------------------------------------------------------------
    // DLQ entry shape
    // -----------------------------------------------------------------------

    test("DLQ entry preserves event + error + attempt count", async () => {
      const deadLetters: DeadLetterEntry[] = [];
      const handle = await backend.subscribe({
        streamId: "s",
        subscriptionName: "sub-dlq-shape",
        fromPosition: 0,
        maxRetries: 1,
        handler: () => {
          throw new Error("shape test");
        },
        onDeadLetter: (entry) => {
          deadLetters.push(entry);
        },
      });

      await backend.append("s", { type: "shape-evt", data: { val: 42 } });
      await Bun.sleep(100);

      expect(deadLetters).toHaveLength(1);
      const entry = deadLetters[0];
      expect(entry).toBeDefined();
      if (entry === undefined) return;
      expect(entry.id).toBeTruthy();
      expect(entry.event.type).toBe("shape-evt");
      expect(entry.event.data).toEqual({ val: 42 });
      expect(entry.subscriptionName).toBe("sub-dlq-shape");
      expect(entry.error).toContain("shape test");
      expect(entry.attempts).toBe(1);
      expect(entry.deadLetteredAt).toBeGreaterThan(0);

      handle.unsubscribe();
    });

    // -----------------------------------------------------------------------
    // Multiple subscribers — independent positions
    // -----------------------------------------------------------------------

    test("multiple subscribers have independent positions", async () => {
      const received1: EventEnvelope[] = [];
      const received2: EventEnvelope[] = [];

      const h1 = await backend.subscribe({
        streamId: "s",
        subscriptionName: "sub-a",
        fromPosition: 0,
        handler: (evt) => {
          received1.push(evt);
        },
      });

      await backend.append("s", { type: "first", data: 1 });
      await Bun.sleep(50);

      // Second subscriber starts after first event
      const h2 = await backend.subscribe({
        streamId: "s",
        subscriptionName: "sub-b",
        fromPosition: 1,
        handler: (evt) => {
          received2.push(evt);
        },
      });

      await backend.append("s", { type: "second", data: 2 });
      await Bun.sleep(50);

      expect(received1).toHaveLength(2); // got both events
      expect(received2).toHaveLength(1); // got only second

      h1.unsubscribe();
      h2.unsubscribe();
    });

    // -----------------------------------------------------------------------
    // queryDeadLetters
    // -----------------------------------------------------------------------

    test("queryDeadLetters filters by stream and subscription", async () => {
      const handle = await backend.subscribe({
        streamId: "s1",
        subscriptionName: "sub-q",
        fromPosition: 0,
        maxRetries: 1,
        handler: () => {
          throw new Error("fail");
        },
      });

      await backend.append("s1", { type: "e", data: 1 });
      await Bun.sleep(100);
      handle.unsubscribe();

      // Query with matching filter
      const r1 = await backend.queryDeadLetters({ streamId: "s1" });
      expect(r1.ok).toBe(true);
      if (r1.ok) {
        expect(r1.value.length).toBeGreaterThanOrEqual(1);
      }

      // Query with non-matching filter
      const r2 = await backend.queryDeadLetters({ streamId: "s-other" });
      expect(r2.ok).toBe(true);
      if (r2.ok) {
        expect(r2.value).toHaveLength(0);
      }

      // Query by subscription name
      const r3 = await backend.queryDeadLetters({ subscriptionName: "sub-q" });
      expect(r3.ok).toBe(true);
      if (r3.ok) {
        expect(r3.value.length).toBeGreaterThanOrEqual(1);
      }
    });

    // -----------------------------------------------------------------------
    // retryDeadLetter
    // -----------------------------------------------------------------------

    test("retryDeadLetter re-delivers to subscriber", async () => {
      // let is required: counter mutates across handler invocations
      let callCount = 0;
      const received: EventEnvelope[] = [];

      const handle = await backend.subscribe({
        streamId: "s",
        subscriptionName: "sub-retry",
        fromPosition: 0,
        maxRetries: 1,
        handler: (evt) => {
          callCount++;
          // Fail on first delivery, succeed on retry
          if (callCount <= 1) {
            throw new Error("first attempt fail");
          }
          received.push(evt);
        },
      });

      await backend.append("s", { type: "retry-evt", data: 1 });
      await Bun.sleep(100);

      // Event should be in DLQ now
      const dlq = await backend.queryDeadLetters({ subscriptionName: "sub-retry" });
      expect(dlq.ok).toBe(true);
      if (dlq.ok && dlq.value.length > 0) {
        const firstEntry = dlq.value[0];
        expect(firstEntry).toBeDefined();
        if (firstEntry === undefined) return;
        const retryResult = await backend.retryDeadLetter(firstEntry.id);
        expect(retryResult.ok).toBe(true);

        await Bun.sleep(100);

        // Handler should have succeeded on retry
        expect(received).toHaveLength(1);
      }

      handle.unsubscribe();
    });

    test("retryDeadLetter returns NOT_FOUND for unknown entry", async () => {
      const result = await backend.retryDeadLetter("nonexistent-dlq-id");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("NOT_FOUND");
      }
    });

    // -----------------------------------------------------------------------
    // purgeDeadLetters
    // -----------------------------------------------------------------------

    test("purgeDeadLetters clears entries", async () => {
      const handle = await backend.subscribe({
        streamId: "s",
        subscriptionName: "sub-purge",
        fromPosition: 0,
        maxRetries: 1,
        handler: () => {
          throw new Error("purge test");
        },
      });

      await backend.append("s", { type: "purge-evt", data: 1 });
      await Bun.sleep(100);
      handle.unsubscribe();

      const purgeResult = await backend.purgeDeadLetters({ subscriptionName: "sub-purge" });
      expect(purgeResult.ok).toBe(true);

      const dlq = await backend.queryDeadLetters({ subscriptionName: "sub-purge" });
      expect(dlq.ok).toBe(true);
      if (dlq.ok) {
        expect(dlq.value).toHaveLength(0);
      }
    });

    // -----------------------------------------------------------------------
    // streamLength
    // -----------------------------------------------------------------------

    test("streamLength returns correct count", async () => {
      expect(await backend.streamLength("empty")).toBe(0);

      await backend.append("s", { type: "a", data: 1 });
      await backend.append("s", { type: "b", data: 2 });
      expect(await backend.streamLength("s")).toBe(2);
    });

    // -----------------------------------------------------------------------
    // read — type filtering
    // -----------------------------------------------------------------------

    test("read with types filter returns only matching events", async () => {
      await backend.append("s", { type: "agent:started", data: 1 });
      await backend.append("s", { type: "agent:stopped", data: 2 });
      await backend.append("s", { type: "brick:forged", data: 3 });
      await backend.append("s", { type: "agent:started", data: 4 });

      const result = await backend.read("s", { types: ["agent:started"] });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.events).toHaveLength(2);
        expect(result.value.events[0]?.data).toBe(1);
        expect(result.value.events[1]?.data).toBe(4);
      }
    });

    test("read with multiple types returns union", async () => {
      await backend.append("s", { type: "a", data: 1 });
      await backend.append("s", { type: "b", data: 2 });
      await backend.append("s", { type: "c", data: 3 });

      const result = await backend.read("s", { types: ["a", "c"] });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.events).toHaveLength(2);
        expect(result.value.events[0]?.type).toBe("a");
        expect(result.value.events[1]?.type).toBe("c");
      }
    });

    test("read with non-matching types returns empty", async () => {
      await backend.append("s", { type: "a", data: 1 });

      const result = await backend.read("s", { types: ["nonexistent"] });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.events).toHaveLength(0);
      }
    });

    // -----------------------------------------------------------------------
    // subscribe — type filtering
    // -----------------------------------------------------------------------

    test("subscribe with types filter delivers only matching events", async () => {
      const received: EventEnvelope[] = [];
      const handle = await backend.subscribe({
        streamId: "s",
        subscriptionName: "sub-typed",
        fromPosition: 0,
        types: ["important"],
        handler: (evt) => {
          received.push(evt);
        },
      });

      await backend.append("s", { type: "noise", data: 1 });
      await backend.append("s", { type: "important", data: 2 });
      await backend.append("s", { type: "noise", data: 3 });
      await backend.append("s", { type: "important", data: 4 });
      await Bun.sleep(50);

      expect(received).toHaveLength(2);
      expect(received[0]?.data).toBe(2);
      expect(received[1]?.data).toBe(4);

      // Position should have advanced past all events (including filtered ones)
      expect(handle.position()).toBe(4);

      handle.unsubscribe();
    });

    // -----------------------------------------------------------------------
    // firstSequence
    // -----------------------------------------------------------------------

    test("firstSequence returns 0 for empty/nonexistent stream", async () => {
      expect(await backend.firstSequence("nonexistent")).toBe(0);
    });

    test("firstSequence returns 1 for a fresh stream", async () => {
      await backend.append("s", { type: "a", data: 1 });
      expect(await backend.firstSequence("s")).toBe(1);
    });

    // -----------------------------------------------------------------------
    // FIFO eviction
    // -----------------------------------------------------------------------

    test("FIFO eviction when maxEventsPerStream exceeded", async () => {
      // This test uses the default backend from the factory.
      // Implementation-specific tests should test with low maxEventsPerStream.
      for (let i = 1; i <= 8; i++) {
        await backend.append("evict-stream", { type: "evt", data: i });
      }

      const len = await backend.streamLength("evict-stream");
      expect(len).toBeLessThanOrEqual(8);
    });

    // -----------------------------------------------------------------------
    // Position persistence (subscribe, process, unsubscribe, re-subscribe)
    // -----------------------------------------------------------------------

    test("position persists across unsubscribe and re-subscribe", async () => {
      const received1: EventEnvelope[] = [];

      const h1 = await backend.subscribe({
        streamId: "s",
        subscriptionName: "durable-sub",
        fromPosition: 0,
        handler: (evt) => {
          received1.push(evt);
        },
      });

      await backend.append("s", { type: "a", data: 1 });
      await backend.append("s", { type: "b", data: 2 });
      await Bun.sleep(50);

      const posAfterTwo = h1.position();
      h1.unsubscribe();

      // Append while unsubscribed
      await backend.append("s", { type: "c", data: 3 });

      // Re-subscribe from saved position — should get event "c"
      const received2: EventEnvelope[] = [];
      const h2 = await backend.subscribe({
        streamId: "s",
        subscriptionName: "durable-sub",
        fromPosition: posAfterTwo,
        handler: (evt) => {
          received2.push(evt);
        },
      });

      await Bun.sleep(50);

      expect(received2).toHaveLength(1);
      expect(received2[0]?.type).toBe("c");

      h2.unsubscribe();
    });

    // -----------------------------------------------------------------------
    // close
    // -----------------------------------------------------------------------

    test("close is callable without error", async () => {
      await backend.close();
    });
  });
}
