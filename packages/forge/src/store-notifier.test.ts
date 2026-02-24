import { describe, expect, test } from "bun:test";
import type { StoreChangeEvent } from "@koi/core";
import { createMemoryStoreChangeNotifier } from "./store-notifier.js";

describe("createMemoryStoreChangeNotifier", () => {
  test("notifies subscribed listeners", () => {
    const notifier = createMemoryStoreChangeNotifier();
    const received: StoreChangeEvent[] = [];

    notifier.subscribe((event) => {
      received.push(event);
    });

    notifier.notify({ kind: "saved", brickId: "brick_1", scope: "agent" });

    expect(received).toEqual([{ kind: "saved", brickId: "brick_1", scope: "agent" }]);
  });

  test("notifies multiple listeners", () => {
    const notifier = createMemoryStoreChangeNotifier();
    const received1: StoreChangeEvent[] = [];
    const received2: StoreChangeEvent[] = [];

    notifier.subscribe((event) => received1.push(event));
    notifier.subscribe((event) => received2.push(event));

    notifier.notify({ kind: "promoted", brickId: "brick_2", scope: "zone" });

    expect(received1.length).toBe(1);
    expect(received2.length).toBe(1);
    expect(received1[0]?.kind).toBe("promoted");
    expect(received2[0]?.kind).toBe("promoted");
  });

  test("unsubscribe stops delivery", () => {
    const notifier = createMemoryStoreChangeNotifier();
    const received: StoreChangeEvent[] = [];

    const unsubscribe = notifier.subscribe((event) => received.push(event));
    notifier.notify({ kind: "saved", brickId: "brick_1" });
    expect(received.length).toBe(1);

    unsubscribe();
    notifier.notify({ kind: "updated", brickId: "brick_1" });
    expect(received.length).toBe(1); // no new events
  });

  test("unsubscribe during notify does not affect current batch", () => {
    const notifier = createMemoryStoreChangeNotifier();
    const received: string[] = [];
    let unsub: (() => void) | undefined;

    // First listener unsubscribes the second listener during notify
    notifier.subscribe(() => {
      received.push("first");
      if (unsub !== undefined) {
        unsub();
      }
    });
    unsub = notifier.subscribe(() => {
      received.push("second");
    });

    notifier.notify({ kind: "saved", brickId: "brick_1" });

    // Both should fire because snapshot was taken before iteration
    expect(received).toEqual(["first", "second"]);

    // But second is now unsubscribed
    received.length = 0;
    notifier.notify({ kind: "saved", brickId: "brick_2" });
    expect(received).toEqual(["first"]);
  });

  test("notify with no subscribers is a no-op", () => {
    const notifier = createMemoryStoreChangeNotifier();
    // Should not throw
    notifier.notify({ kind: "removed", brickId: "brick_1" });
  });

  test("multiple unsubscribe calls are safe", () => {
    const notifier = createMemoryStoreChangeNotifier();
    const unsubscribe = notifier.subscribe(() => {});

    unsubscribe();
    unsubscribe(); // Should not throw
  });

  test("events without scope are delivered correctly", () => {
    const notifier = createMemoryStoreChangeNotifier();
    const received: StoreChangeEvent[] = [];

    notifier.subscribe((event) => received.push(event));
    notifier.notify({ kind: "removed", brickId: "brick_1" });

    expect(received).toEqual([{ kind: "removed", brickId: "brick_1" }]);
    expect(received[0]?.scope).toBeUndefined();
  });
});
