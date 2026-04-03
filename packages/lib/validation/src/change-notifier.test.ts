import { describe, expect, mock, test } from "bun:test";
import { createMemoryChangeNotifier } from "./change-notifier.js";

interface TestEvent {
  readonly kind: "created" | "deleted";
  readonly id: string;
}

describe("createMemoryChangeNotifier", () => {
  test("notify delivers event to subscriber", () => {
    const notifier = createMemoryChangeNotifier<TestEvent>();
    const received: TestEvent[] = [];
    notifier.subscribe((e) => received.push(e));

    notifier.notify({ kind: "created", id: "1" });

    expect(received).toEqual([{ kind: "created", id: "1" }]);
  });

  test("notify delivers event to multiple subscribers", () => {
    const notifier = createMemoryChangeNotifier<TestEvent>();
    const received1: TestEvent[] = [];
    const received2: TestEvent[] = [];
    notifier.subscribe((e) => received1.push(e));
    notifier.subscribe((e) => received2.push(e));

    notifier.notify({ kind: "deleted", id: "2" });

    expect(received1).toEqual([{ kind: "deleted", id: "2" }]);
    expect(received2).toEqual([{ kind: "deleted", id: "2" }]);
  });

  test("unsubscribe stops notifications", () => {
    const notifier = createMemoryChangeNotifier<TestEvent>();
    const received: TestEvent[] = [];
    const unsub = notifier.subscribe((e) => received.push(e));

    notifier.notify({ kind: "created", id: "1" });
    unsub();
    notifier.notify({ kind: "created", id: "2" });

    expect(received).toEqual([{ kind: "created", id: "1" }]);
  });

  test("unsubscribe is idempotent", () => {
    const notifier = createMemoryChangeNotifier<TestEvent>();
    const unsub = notifier.subscribe(() => undefined);

    // Call unsubscribe multiple times — should not throw
    unsub();
    unsub();
    unsub();
  });

  test("error in one listener does not break others", () => {
    const notifier = createMemoryChangeNotifier<TestEvent>();
    const received: TestEvent[] = [];

    notifier.subscribe(() => {
      throw new Error("boom");
    });
    notifier.subscribe((e) => received.push(e));

    notifier.notify({ kind: "created", id: "1" });

    expect(received).toEqual([{ kind: "created", id: "1" }]);
  });

  test("listener unsubscribing during notify does not affect iteration", () => {
    const notifier = createMemoryChangeNotifier<TestEvent>();
    const received: TestEvent[] = [];
    let unsub2: (() => void) | undefined;

    notifier.subscribe(() => {
      // First listener unsubscribes the second during notification
      unsub2?.();
    });
    unsub2 = notifier.subscribe((e) => received.push(e));

    // Second listener should still receive this event (snapshot iteration)
    notifier.notify({ kind: "created", id: "1" });

    expect(received).toEqual([{ kind: "created", id: "1" }]);
  });

  test("throws when subscriber limit is reached", () => {
    const notifier = createMemoryChangeNotifier<TestEvent>();

    // Subscribe up to the limit (64)
    for (let i = 0; i < 64; i++) {
      notifier.subscribe(() => undefined);
    }

    // 65th subscription should throw
    expect(() => notifier.subscribe(() => undefined)).toThrow(/subscriber limit.*64/);
  });

  test("unsubscribing frees a slot for new subscribers", () => {
    const notifier = createMemoryChangeNotifier<TestEvent>();
    const unsubs: (() => void)[] = [];

    for (let i = 0; i < 64; i++) {
      unsubs.push(notifier.subscribe(() => undefined));
    }

    // At limit — should throw
    expect(() => notifier.subscribe(() => undefined)).toThrow(/subscriber limit/);

    // Free a slot
    unsubs[0]?.();

    // Should succeed now
    const fn = mock(() => undefined);
    notifier.subscribe(fn);
    notifier.notify({ kind: "created", id: "1" });
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
