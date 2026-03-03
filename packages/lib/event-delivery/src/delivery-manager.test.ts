import { beforeEach, describe, expect, test } from "bun:test";
import type { DeadLetterEntry, EventEnvelope } from "@koi/core";
import type { DeliveryCallbacks } from "./delivery-manager.js";
import { createDeliveryManager } from "./delivery-manager.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function createEnvelope(overrides: Partial<EventEnvelope> = {}): EventEnvelope {
  return {
    id: `evt-${String(Math.random()).slice(2, 8)}`,
    streamId: "test-stream",
    type: "test:event",
    timestamp: Date.now(),
    sequence: 1,
    data: { value: 1 },
    ...overrides,
  };
}

function createNoopCallbacks(events: readonly EventEnvelope[] = []): DeliveryCallbacks & {
  readonly positions: Map<string, number>;
  readonly deadLetters: DeadLetterEntry[];
} {
  const positions = new Map<string, number>();
  const deadLetters: DeadLetterEntry[] = [];
  return {
    positions,
    deadLetters,
    persistPosition: (name, seq) => {
      positions.set(name, seq);
    },
    persistDeadLetter: (entry) => {
      deadLetters.push(entry);
    },
    readStream: (_streamId, fromSequence) => events.filter((e) => e.sequence > fromSequence),
    removeDeadLetter: (id) => {
      const idx = deadLetters.findIndex((e) => e.id === id);
      if (idx >= 0) {
        deadLetters.splice(idx, 1);
        return true;
      }
      return false;
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createDeliveryManager", () => {
  describe("subscribe", () => {
    test("delivers events via notifySubscribers", async () => {
      const cb = createNoopCallbacks();
      const dm = createDeliveryManager(cb);
      const received: EventEnvelope[] = [];

      dm.subscribe({
        streamId: "s",
        subscriptionName: "sub-1",
        fromPosition: 0,
        handler: (evt) => {
          received.push(evt);
        },
      });

      const evt = createEnvelope({ streamId: "s", sequence: 1 });
      dm.notifySubscribers("s", evt);
      await Bun.sleep(50);

      expect(received).toHaveLength(1);
      expect(received[0]?.sequence).toBe(1);
    });

    test("replays existing events on subscribe", async () => {
      const events = [
        createEnvelope({ streamId: "s", sequence: 1 }),
        createEnvelope({ streamId: "s", sequence: 2 }),
      ];
      const cb = createNoopCallbacks(events);
      const dm = createDeliveryManager(cb);
      const received: EventEnvelope[] = [];

      dm.subscribe({
        streamId: "s",
        subscriptionName: "sub-replay",
        fromPosition: 0,
        handler: (evt) => {
          received.push(evt);
        },
      });

      await Bun.sleep(50);
      expect(received).toHaveLength(2);
    });

    test("unsubscribe stops delivery", async () => {
      const cb = createNoopCallbacks();
      const dm = createDeliveryManager(cb);
      const received: EventEnvelope[] = [];

      const handle = dm.subscribe({
        streamId: "s",
        subscriptionName: "sub-unsub",
        fromPosition: 0,
        handler: (evt) => {
          received.push(evt);
        },
      });

      handle.unsubscribe();

      dm.notifySubscribers("s", createEnvelope({ streamId: "s", sequence: 1 }));
      await Bun.sleep(50);

      expect(received).toHaveLength(0);
    });

    test("position tracks last delivered sequence", async () => {
      const cb = createNoopCallbacks();
      const dm = createDeliveryManager(cb);

      const handle = dm.subscribe({
        streamId: "s",
        subscriptionName: "sub-pos",
        fromPosition: 0,
        handler: () => {},
      });

      dm.notifySubscribers("s", createEnvelope({ streamId: "s", sequence: 1 }));
      dm.notifySubscribers("s", createEnvelope({ streamId: "s", sequence: 2 }));
      await Bun.sleep(50);

      expect(handle.position()).toBe(2);
      expect(cb.positions.get("sub-pos")).toBe(2);
    });
  });

  describe("type filtering", () => {
    test("delivers only matching event types", async () => {
      const cb = createNoopCallbacks();
      const dm = createDeliveryManager(cb);
      const received: EventEnvelope[] = [];

      const handle = dm.subscribe({
        streamId: "s",
        subscriptionName: "sub-typed",
        fromPosition: 0,
        types: ["important"],
        handler: (evt) => {
          received.push(evt);
        },
      });

      dm.notifySubscribers("s", createEnvelope({ streamId: "s", sequence: 1, type: "noise" }));
      dm.notifySubscribers("s", createEnvelope({ streamId: "s", sequence: 2, type: "important" }));
      dm.notifySubscribers("s", createEnvelope({ streamId: "s", sequence: 3, type: "noise" }));
      await Bun.sleep(50);

      expect(received).toHaveLength(1);
      expect(received[0]?.type).toBe("important");
      // Position advances past all events including filtered ones
      expect(handle.position()).toBe(3);
    });
  });

  describe("dead letter queue", () => {
    let cb: ReturnType<typeof createNoopCallbacks>;
    let dm: ReturnType<typeof createDeliveryManager>;

    beforeEach(() => {
      cb = createNoopCallbacks();
      dm = createDeliveryManager(cb);
    });

    test("dead-letters after max retries", async () => {
      const deadLetters: DeadLetterEntry[] = [];
      dm.subscribe({
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

      dm.notifySubscribers("s", createEnvelope({ streamId: "s", sequence: 1 }));
      await Bun.sleep(100);

      expect(deadLetters).toHaveLength(1);
      expect(deadLetters[0]?.attempts).toBe(2);
      expect(deadLetters[0]?.error).toContain("handler boom");
    });

    test("queryDeadLetters filters by subscription", async () => {
      dm.subscribe({
        streamId: "s",
        subscriptionName: "sub-q",
        fromPosition: 0,
        maxRetries: 1,
        handler: () => {
          throw new Error("fail");
        },
      });

      dm.notifySubscribers("s", createEnvelope({ streamId: "s", sequence: 1 }));
      await Bun.sleep(100);

      const r1 = dm.queryDeadLetters({ subscriptionName: "sub-q" });
      expect(r1.ok).toBe(true);
      if (r1.ok) expect(r1.value.length).toBeGreaterThanOrEqual(1);

      const r2 = dm.queryDeadLetters({ subscriptionName: "other" });
      expect(r2.ok).toBe(true);
      if (r2.ok) expect(r2.value).toHaveLength(0);
    });

    test("retryDeadLetter re-delivers to subscriber", async () => {
      // let is required: counter mutates across handler invocations
      let callCount = 0;
      const received: EventEnvelope[] = [];

      dm.subscribe({
        streamId: "s",
        subscriptionName: "sub-retry",
        fromPosition: 0,
        maxRetries: 1,
        handler: (evt) => {
          callCount++;
          if (callCount <= 1) throw new Error("first attempt fail");
          received.push(evt);
        },
      });

      dm.notifySubscribers("s", createEnvelope({ streamId: "s", sequence: 1 }));
      await Bun.sleep(100);

      const dlq = dm.queryDeadLetters({ subscriptionName: "sub-retry" });
      expect(dlq.ok).toBe(true);
      if (dlq.ok && dlq.value.length > 0) {
        const firstEntry = dlq.value[0];
        if (firstEntry !== undefined) {
          const retryResult = await dm.retryDeadLetter(firstEntry.id);
          expect(retryResult.ok).toBe(true);
          await Bun.sleep(100);
          expect(received).toHaveLength(1);
        }
      }
    });

    test("retryDeadLetter returns NOT_FOUND for unknown entry", () => {
      const result = dm.retryDeadLetter("nonexistent");
      // Sync path returns immediately
      expect(result).toEqual(expect.objectContaining({ ok: false }));
      if ("ok" in result && !result.ok) {
        expect(result.error.code).toBe("NOT_FOUND");
      }
    });

    test("evicts oldest entries when maxDeadLetters exceeded", async () => {
      const cb2 = createNoopCallbacks();
      const dm2 = createDeliveryManager(cb2, { maxDeadLetters: 3 });

      dm2.subscribe({
        streamId: "s",
        subscriptionName: "sub-cap",
        fromPosition: 0,
        maxRetries: 1,
        handler: () => {
          throw new Error("always fails");
        },
      });

      for (let i = 1; i <= 5; i++) {
        dm2.notifySubscribers("s", createEnvelope({ streamId: "s", sequence: i }));
      }
      await Bun.sleep(200);

      const dlq = dm2.queryDeadLetters({ subscriptionName: "sub-cap" });
      expect(dlq.ok).toBe(true);
      if (dlq.ok) {
        // 5 failures but only 3 kept (oldest 2 evicted)
        expect(dlq.value).toHaveLength(3);
        // Remaining entries are the 3 most recent (sequences 3, 4, 5)
        expect(dlq.value[0]?.event.sequence).toBe(3);
        expect(dlq.value[2]?.event.sequence).toBe(5);
      }
    });

    test("purgeDeadLetters clears matching entries", async () => {
      dm.subscribe({
        streamId: "s",
        subscriptionName: "sub-purge",
        fromPosition: 0,
        maxRetries: 1,
        handler: () => {
          throw new Error("purge test");
        },
      });

      dm.notifySubscribers("s", createEnvelope({ streamId: "s", sequence: 1 }));
      await Bun.sleep(100);

      dm.purgeDeadLetters({ subscriptionName: "sub-purge" });

      const dlq = dm.queryDeadLetters({ subscriptionName: "sub-purge" });
      expect(dlq.ok).toBe(true);
      if (dlq.ok) expect(dlq.value).toHaveLength(0);
    });
  });

  describe("closeAll", () => {
    test("deactivates all subscriptions", async () => {
      const cb = createNoopCallbacks();
      const dm = createDeliveryManager(cb);
      const received: EventEnvelope[] = [];

      dm.subscribe({
        streamId: "s",
        subscriptionName: "sub-close",
        fromPosition: 0,
        handler: (evt) => {
          received.push(evt);
        },
      });

      dm.closeAll();

      dm.notifySubscribers("s", createEnvelope({ streamId: "s", sequence: 1 }));
      await Bun.sleep(50);

      expect(received).toHaveLength(0);
    });
  });
});
