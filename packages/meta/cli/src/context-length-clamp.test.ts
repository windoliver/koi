import { describe, expect, test } from "bun:test";
import { clampContextLength } from "./tui-command.js";

describe("clampContextLength", () => {
  test("undefined passes through", () => {
    expect(clampContextLength(undefined)).toBeUndefined();
  });

  test("rejects zero", () => {
    expect(clampContextLength(0)).toBeUndefined();
  });

  test("rejects negative", () => {
    expect(clampContextLength(-1024)).toBeUndefined();
    expect(clampContextLength(-1)).toBeUndefined();
  });

  test("rejects values below min (2048)", () => {
    expect(clampContextLength(1024)).toBeUndefined();
    expect(clampContextLength(2047)).toBeUndefined();
  });

  test("rejects pathological large values", () => {
    expect(clampContextLength(10_000_000)).toBeUndefined();
    expect(clampContextLength(Number.MAX_SAFE_INTEGER)).toBeUndefined();
  });

  test("rejects NaN and Infinity", () => {
    expect(clampContextLength(Number.NaN)).toBeUndefined();
    expect(clampContextLength(Number.POSITIVE_INFINITY)).toBeUndefined();
    expect(clampContextLength(Number.NEGATIVE_INFINITY)).toBeUndefined();
  });

  test("rejects non-integers", () => {
    expect(clampContextLength(200_000.5)).toBeUndefined();
  });

  test("accepts typical context windows", () => {
    expect(clampContextLength(8192)).toBe(8192);
    expect(clampContextLength(32_000)).toBe(32_000);
    expect(clampContextLength(200_000)).toBe(200_000);
    expect(clampContextLength(1_000_000)).toBe(1_000_000);
  });

  test("accepts boundary values", () => {
    expect(clampContextLength(2048)).toBe(2048);
    expect(clampContextLength(4_000_000)).toBe(4_000_000);
  });
});
