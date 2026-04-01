import { describe, expect, test } from "bun:test";
import { parseDuration } from "./duration.js";

describe("parseDuration", () => {
  test("parses seconds to milliseconds", () => {
    expect(parseDuration("30s")).toBe(30_000);
  });

  test("parses minutes to milliseconds", () => {
    expect(parseDuration("5m")).toBe(300_000);
  });

  test("parses hours to milliseconds", () => {
    expect(parseDuration("1h")).toBe(3_600_000);
  });

  test("returns undefined for zero value", () => {
    expect(parseDuration("0s")).toBeUndefined();
  });

  test("returns undefined for invalid input", () => {
    expect(parseDuration("abc")).toBeUndefined();
  });

  test("returns undefined for empty string", () => {
    expect(parseDuration("")).toBeUndefined();
  });

  test("returns undefined for unsupported unit", () => {
    expect(parseDuration("5d")).toBeUndefined();
  });

  test("returns undefined for negative value", () => {
    expect(parseDuration("-1s")).toBeUndefined();
  });

  test("parses large values", () => {
    expect(parseDuration("120m")).toBe(7_200_000);
  });
});
