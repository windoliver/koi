import { describe, expect, test } from "bun:test";
import { createSharedLog, DEFAULT_MAX_SHARED_LOG_ENTRIES } from "./shared-log.js";

describe("createSharedLog", () => {
  test("append adds entries", () => {
    const log = createSharedLog();
    log.append("finding-1");
    log.append("finding-2");
    expect(log.entries()).toEqual(["finding-1", "finding-2"]);
  });

  test("entries returns readonly array (oldest first)", () => {
    const log = createSharedLog();
    log.append("first");
    log.append("second");
    log.append("third");
    const result = log.entries();
    expect(result[0]).toBe("first");
    expect(result[1]).toBe("second");
    expect(result[2]).toBe("third");
  });

  test("cap enforced — oldest entries dropped when exceeding maxEntries", () => {
    const log = createSharedLog(3);
    log.append("a");
    log.append("b");
    log.append("c");
    log.append("d");
    expect(log.entries()).toEqual(["b", "c", "d"]);
    expect(log.size()).toBe(3);
  });

  test("clear removes all entries", () => {
    const log = createSharedLog();
    log.append("x");
    log.append("y");
    expect(log.size()).toBe(2);
    log.clear();
    expect(log.size()).toBe(0);
    expect(log.entries()).toEqual([]);
  });

  test("size returns correct count", () => {
    const log = createSharedLog();
    expect(log.size()).toBe(0);
    log.append("one");
    expect(log.size()).toBe(1);
    log.append("two");
    expect(log.size()).toBe(2);
  });

  test("default maxEntries is 20", () => {
    expect(DEFAULT_MAX_SHARED_LOG_ENTRIES).toBe(20);
    const log = createSharedLog();
    for (let i = 0; i < 25; i++) {
      log.append(`entry-${i}`);
    }
    expect(log.size()).toBe(20);
    // Oldest 5 dropped, first remaining is entry-5
    expect(log.entries()[0]).toBe("entry-5");
  });

  test("custom maxEntries works", () => {
    const log = createSharedLog(5);
    for (let i = 0; i < 8; i++) {
      log.append(`item-${i}`);
    }
    expect(log.size()).toBe(5);
    expect(log.entries()).toEqual(["item-3", "item-4", "item-5", "item-6", "item-7"]);
  });
});
