import { describe, expect, test } from "bun:test";
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
});
