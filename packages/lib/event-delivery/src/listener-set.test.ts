import { describe, expect, mock, test } from "bun:test";
import { createListenerSet } from "./listener-set.js";

describe("createListenerSet", () => {
  test("notifies all listeners", () => {
    const set = createListenerSet<string>();
    const received: string[] = [];
    set.subscribe((e) => received.push(e));
    set.subscribe((e) => received.push(`copy:${e}`));

    set.notify("hello");

    expect(received).toEqual(["hello", "copy:hello"]);
  });

  test("swallows listener errors without breaking other listeners", () => {
    const set = createListenerSet<number>();
    const received: number[] = [];
    set.subscribe(() => {
      throw new Error("boom");
    });
    set.subscribe((n) => received.push(n));

    set.notify(42);

    expect(received).toEqual([42]);
  });

  test("unsubscribe removes the listener", () => {
    const set = createListenerSet<string>();
    const received: string[] = [];
    const unsub = set.subscribe((e) => received.push(e));

    set.notify("a");
    unsub();
    set.notify("b");

    expect(received).toEqual(["a"]);
  });

  test("size tracks active listeners", () => {
    const set = createListenerSet<string>();
    expect(set.size()).toBe(0);

    const unsub1 = set.subscribe(() => {});
    const unsub2 = set.subscribe(() => {});
    expect(set.size()).toBe(2);

    unsub1();
    expect(set.size()).toBe(1);

    unsub2();
    expect(set.size()).toBe(0);
  });

  test("double unsubscribe is safe", () => {
    const set = createListenerSet<string>();
    const unsub = set.subscribe(() => {});
    unsub();
    unsub(); // should not throw
    expect(set.size()).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // Snapshot iteration
  // ---------------------------------------------------------------------------

  test("snapshot guarantees all listeners fire even if one unsubscribes another", () => {
    const set = createListenerSet<string>();
    const received: string[] = [];

    // Listener A unsubscribes listener B during notification.
    // With snapshot iteration, B should still fire for this notification.
    // let: unsub ref captured by closure before assignment
    let unsubB: (() => void) | undefined;
    set.subscribe((e) => {
      received.push(`A:${e}`);
      unsubB?.();
    });
    unsubB = set.subscribe((e) => {
      received.push(`B:${e}`);
    });

    set.notify("evt");

    expect(received).toEqual(["A:evt", "B:evt"]);

    // After the notification, B should be unsubscribed — second notify should not reach B
    received.length = 0;
    set.notify("evt2");
    expect(received).toEqual(["A:evt2"]);
  });

  // ---------------------------------------------------------------------------
  // onError callback
  // ---------------------------------------------------------------------------

  test("onError callback receives error and event", () => {
    const onError = mock<(err: unknown, event: string) => void>(() => {});
    const set = createListenerSet<string>({ onError });

    const thrown = new Error("kaboom");
    set.subscribe(() => {
      throw thrown;
    });

    set.notify("test-event");

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(thrown, "test-event");
  });

  test("multiple listeners can throw independently with onError", () => {
    const errors: unknown[] = [];
    const set = createListenerSet<number>({
      onError: (err) => errors.push(err),
    });

    const err1 = new Error("one");
    const err2 = new Error("two");
    set.subscribe(() => {
      throw err1;
    });
    set.subscribe(() => {
      throw err2;
    });

    set.notify(42);

    expect(errors).toEqual([err1, err2]);
  });
});
