import { describe, expect, test } from "bun:test";
import { extractOutput } from "./output.js";

describe("extractOutput", () => {
  test("returns the success output text", () => {
    expect(extractOutput({ ok: true, output: "hello" })).toBe("hello");
  });

  test("returns default message on empty success", () => {
    expect(extractOutput({ ok: true, output: "" })).toBe("(task completed with no output)");
  });

  test("returns Task failed for failures", () => {
    expect(extractOutput({ ok: false, error: "boom" })).toBe("Task failed: boom");
  });
});
