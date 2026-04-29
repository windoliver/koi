import { describe, expect, test } from "bun:test";
import { emptyStats, welfordUpdate } from "./latency.js";

describe("welfordUpdate", () => {
  test("matches population mean and stddev for [2, 4, 4, 4, 5, 5, 7, 9]", () => {
    let s = emptyStats();
    for (const x of [2, 4, 4, 4, 5, 5, 7, 9]) s = welfordUpdate(s, x);
    expect(s.mean).toBe(5);
    expect(Math.round(s.stddev * 1e6) / 1e6).toBe(2);
    expect(s.count).toBe(8);
  });

  test("count=0 returns zeros", () => {
    const s = emptyStats();
    expect(s).toEqual({ mean: 0, stddev: 0, count: 0, m2: 0 });
  });

  test("count=1 has stddev=0", () => {
    const s = welfordUpdate(emptyStats(), 42);
    expect(s.mean).toBe(42);
    expect(s.stddev).toBe(0);
    expect(s.count).toBe(1);
  });

  test("constant stream has stddev=0", () => {
    let s = emptyStats();
    for (let i = 0; i < 5; i++) s = welfordUpdate(s, 100);
    expect(s.mean).toBe(100);
    expect(s.stddev).toBe(0);
  });
});
