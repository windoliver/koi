import { describe, expect, test } from "bun:test";
import { createOutputAccumulator } from "./truncate.js";

describe("createOutputAccumulator", () => {
  test("accumulates small chunks without truncation", () => {
    const acc = createOutputAccumulator(1024);
    acc.append("hello ");
    acc.append("world");
    const { output, truncated } = acc.result();
    expect(output).toBe("hello world");
    expect(truncated).toBe(false);
  });

  test("truncates when exceeding byte limit", () => {
    const acc = createOutputAccumulator(10);
    acc.append("12345");
    acc.append("67890");
    acc.append("XXXXX"); // should be dropped
    const { output, truncated } = acc.result();
    expect(truncated).toBe(true);
    expect(new TextEncoder().encode(output).byteLength).toBeLessThanOrEqual(10);
  });

  test("partial chunk is included up to the limit", () => {
    const acc = createOutputAccumulator(8);
    acc.append("abcd"); // 4 bytes
    acc.append("efghij"); // 6 bytes, only 4 should fit
    const { output, truncated } = acc.result();
    expect(truncated).toBe(true);
    expect(output.startsWith("abcd")).toBe(true);
    expect(new TextEncoder().encode(output).byteLength).toBeLessThanOrEqual(8);
  });

  test("ignores chunks after truncation", () => {
    const acc = createOutputAccumulator(5);
    acc.append("12345");
    acc.append("more data"); // exceeds limit, gets dropped
    const { output, truncated } = acc.result();
    expect(output).toBe("12345");
    expect(truncated).toBe(true);
  });

  test("exact fit does not truncate", () => {
    const acc = createOutputAccumulator(5);
    acc.append("12345");
    const { output, truncated } = acc.result();
    expect(output).toBe("12345");
    expect(truncated).toBe(false);
  });

  test("empty accumulator returns empty string", () => {
    const acc = createOutputAccumulator(100);
    const { output, truncated } = acc.result();
    expect(output).toBe("");
    expect(truncated).toBe(false);
  });

  test("uses default 10MB limit when no maxBytes provided", () => {
    const acc = createOutputAccumulator();
    // Should not truncate small input
    acc.append("x".repeat(1000));
    const { truncated } = acc.result();
    expect(truncated).toBe(false);
  });

  test("zero byte limit truncates everything", () => {
    const acc = createOutputAccumulator(0);
    acc.append("anything");
    const { output, truncated } = acc.result();
    expect(output).toBe("");
    expect(truncated).toBe(true);
  });
});
