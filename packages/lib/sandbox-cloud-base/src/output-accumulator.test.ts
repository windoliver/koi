import { describe, expect, test } from "bun:test";
import {
  createOutputAccumulator,
  DEFAULT_MAX_OUTPUT_BYTES,
} from "./output-accumulator.js";

describe("createOutputAccumulator", () => {
  test("exports the documented default byte limit", () => {
    expect(DEFAULT_MAX_OUTPUT_BYTES).toBe(10 * 1024 * 1024);
  });

  test("accumulates exact-fit output without truncation", () => {
    const accumulator = createOutputAccumulator(5);

    accumulator.append("hello");

    expect(accumulator.result()).toEqual({
      output: "hello",
      truncated: false,
    });
  });

  test("truncates by bytes without corrupting utf-8 sequences", () => {
    const accumulator = createOutputAccumulator(5);

    accumulator.append("ab😀");

    expect(accumulator.result()).toEqual({
      output: "ab",
      truncated: true,
    });
  });

  test("ignores additional chunks after truncation", () => {
    const accumulator = createOutputAccumulator(4);

    accumulator.append("toolong");
    accumulator.append("later");

    expect(accumulator.result()).toEqual({
      output: "tool",
      truncated: true,
    });
  });
});
