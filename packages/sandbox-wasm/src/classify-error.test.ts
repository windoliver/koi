import { describe, expect, test } from "bun:test";
import { classifyError } from "./classify-error.js";

describe("classifyError", () => {
  test("classifies InternalError interrupted as TIMEOUT", () => {
    const result = classifyError({ name: "InternalError", message: "interrupted" }, 100);
    expect(result).toEqual({ code: "TIMEOUT", message: "interrupted", durationMs: 100 });
  });

  test("classifies out of memory as OOM", () => {
    const result = classifyError({ name: "InternalError", message: "out of memory" }, 50);
    expect(result).toEqual({ code: "OOM", message: "out of memory", durationMs: 50 });
  });

  test("classifies generic error as CRASH", () => {
    const result = classifyError({ name: "Error", message: "boom" }, 10);
    expect(result).toEqual({ code: "CRASH", message: "boom", durationMs: 10 });
  });

  test("classifies SyntaxError as CRASH", () => {
    const result = classifyError({ name: "SyntaxError", message: "unexpected token" }, 5);
    expect(result).toEqual({ code: "CRASH", message: "unexpected token", durationMs: 5 });
  });

  test("classifies string value as CRASH", () => {
    const result = classifyError("some string error", 42);
    expect(result).toEqual({ code: "CRASH", message: "some string error", durationMs: 42 });
  });

  test("classifies number value as CRASH", () => {
    const result = classifyError(12345, 10);
    expect(result).toEqual({ code: "CRASH", message: "12345", durationMs: 10 });
  });

  test("classifies null as CRASH", () => {
    const result = classifyError(null, 7);
    expect(result).toEqual({ code: "CRASH", message: "null", durationMs: 7 });
  });

  test("classifies object without message as CRASH with stringified form", () => {
    const result = classifyError({ name: "InternalError" }, 20);
    expect(result.code).toBe("CRASH");
    expect(result.durationMs).toBe(20);
  });

  test("uses Unknown error when message is undefined", () => {
    const result = classifyError({ message: undefined }, 20);
    expect(result).toEqual({ code: "CRASH", message: "Unknown error", durationMs: 20 });
  });
});
