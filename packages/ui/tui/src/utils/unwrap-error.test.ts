import { describe, expect, test } from "bun:test";
import { unwrapErrorMessage } from "./unwrap-error.js";

describe("unwrapErrorMessage", () => {
  test("plain string returns unchanged", () => {
    expect(unwrapErrorMessage("Connection refused")).toBe("Connection refused");
  });

  test("empty string returns empty", () => {
    expect(unwrapErrorMessage("")).toBe("");
  });

  test('simple JSON with error field: {"error":"msg"} extracts message', () => {
    expect(unwrapErrorMessage('{"error":"msg"}')).toBe("msg");
  });

  test('nested error: {"error":{"message":"msg"}} extracts message', () => {
    expect(unwrapErrorMessage('{"error":{"message":"msg"}}')).toBe("msg");
  });

  test("double-encoded JSON extracts message", () => {
    const inner = JSON.stringify({ error: "msg" });
    const doubleEncoded = JSON.stringify(inner);
    expect(unwrapErrorMessage(doubleEncoded)).toBe("msg");
  });

  test('.message field: {"message":"msg"} extracts message', () => {
    expect(unwrapErrorMessage('{"message":"msg"}')).toBe("msg");
  });

  test('.detail field: {"detail":"msg"} extracts message', () => {
    expect(unwrapErrorMessage('{"detail":"msg"}')).toBe("msg");
  });

  test("non-JSON string returns unchanged", () => {
    expect(unwrapErrorMessage("just some text")).toBe("just some text");
  });

  test("array JSON returns raw string", () => {
    const raw = "[1,2,3]";
    expect(unwrapErrorMessage(raw)).toBe(raw);
  });

  test("number JSON returns raw string", () => {
    const raw = "42";
    expect(unwrapErrorMessage(raw)).toBe(raw);
  });

  test("deeply nested (3 levels) extracts message", () => {
    // Level 1: { error: "<level2>" }
    // Level 2: { message: "<level3>" }
    // Level 3: plain string
    const level2 = JSON.stringify({ message: "deep msg" });
    const level1 = JSON.stringify({ error: level2 });
    expect(unwrapErrorMessage(level1)).toBe("deep msg");
  });

  test("object with no known error fields returns raw", () => {
    const raw = '{"foo":"bar","baz":123}';
    expect(unwrapErrorMessage(raw)).toBe(raw);
  });

  test("error field is object without message returns raw JSON", () => {
    const raw = '{"error":{"code":500,"status":"fail"}}';
    expect(unwrapErrorMessage(raw)).toBe(raw);
  });
});
