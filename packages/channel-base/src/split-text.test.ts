/**
 * Unit tests for splitText().
 */

import { describe, expect, test } from "bun:test";
import { splitText } from "./split-text.js";

describe("splitText", () => {
  test("returns single-element array for text within limit", () => {
    expect(splitText("hello", 2000)).toEqual(["hello"]);
  });

  test("splits at the given character limit", () => {
    const text = "a".repeat(2001);
    const parts = splitText(text, 2000);
    expect(parts.length).toBe(2);
    expect(parts[0]?.length).toBeLessThanOrEqual(2000);
    expect(parts.join("")).toBe(text);
  });

  test("prefers splitting at newlines", () => {
    const text = `${"a".repeat(1990)}\n${"b".repeat(100)}`;
    const parts = splitText(text, 2000);
    expect(parts.length).toBe(2);
    expect(parts[0]?.endsWith("a")).toBe(true);
  });

  test("handles text with no newlines", () => {
    const text = "x".repeat(4001);
    const parts = splitText(text, 2000);
    expect(parts.length).toBe(3);
    for (const part of parts) {
      expect(part.length).toBeLessThanOrEqual(2000);
    }
  });

  test("returns single-element array for empty string", () => {
    expect(splitText("", 2000)).toEqual([""]);
  });

  test("respects different limits (Telegram 4096)", () => {
    const text = "a".repeat(5000);
    const parts = splitText(text, 4096);
    expect(parts.length).toBe(2);
    expect(parts[0]?.length).toBeLessThanOrEqual(4096);
    expect(parts.join("")).toBe(text);
  });

  test("text exactly at limit returns single chunk", () => {
    const text = "b".repeat(4096);
    const parts = splitText(text, 4096);
    expect(parts.length).toBe(1);
    expect(parts[0]).toBe(text);
  });
});
