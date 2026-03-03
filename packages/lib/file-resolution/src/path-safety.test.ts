import { describe, expect, test } from "bun:test";
import { isValidPathSegment } from "./path-safety.js";

describe("isValidPathSegment", () => {
  // --- Valid segments ---

  test("accepts simple filename", () => {
    expect(isValidPathSegment("INSTRUCTIONS.md")).toBe(true);
  });

  test("accepts alphanumeric with hyphens", () => {
    expect(isValidPathSegment("my-agent")).toBe(true);
  });

  test("accepts alphanumeric with underscores", () => {
    expect(isValidPathSegment("my_agent")).toBe(true);
  });

  test("accepts alphanumeric with dots", () => {
    expect(isValidPathSegment("agent.v2")).toBe(true);
  });

  test("accepts versioned filename", () => {
    expect(isValidPathSegment("config.v2.yaml")).toBe(true);
  });

  test("accepts single alphanumeric character", () => {
    expect(isValidPathSegment("a")).toBe(true);
  });

  test("accepts numeric-only segment", () => {
    expect(isValidPathSegment("123")).toBe(true);
  });

  test("accepts mixed case with numbers", () => {
    expect(isValidPathSegment("MyAgent42")).toBe(true);
  });

  // --- Invalid: path traversal ---

  test("rejects parent directory traversal (..)", () => {
    expect(isValidPathSegment("..")).toBe(false);
  });

  test("rejects relative path with traversal (../etc)", () => {
    expect(isValidPathSegment("../etc")).toBe(false);
  });

  test("rejects deep traversal (../../../etc/passwd)", () => {
    expect(isValidPathSegment("../../../etc/passwd")).toBe(false);
  });

  test("rejects current directory (.)", () => {
    expect(isValidPathSegment(".")).toBe(false);
  });

  // --- Invalid: hidden files ---

  test("rejects hidden file (.hidden)", () => {
    expect(isValidPathSegment(".hidden")).toBe(false);
  });

  test("rejects dotfile (.env)", () => {
    expect(isValidPathSegment(".env")).toBe(false);
  });

  test("rejects .gitignore", () => {
    expect(isValidPathSegment(".gitignore")).toBe(false);
  });

  // --- Invalid: special characters ---

  test("rejects path with forward slash", () => {
    expect(isValidPathSegment("foo/bar")).toBe(false);
  });

  test("rejects path with backslash", () => {
    expect(isValidPathSegment("foo\\bar")).toBe(false);
  });

  test("rejects path with null byte", () => {
    expect(isValidPathSegment("foo\0bar")).toBe(false);
  });

  test("rejects path with space", () => {
    expect(isValidPathSegment("foo bar")).toBe(false);
  });

  test("rejects path with tilde", () => {
    expect(isValidPathSegment("~root")).toBe(false);
  });

  // --- Invalid: empty or whitespace ---

  test("rejects empty string", () => {
    expect(isValidPathSegment("")).toBe(false);
  });

  test("rejects whitespace-only string", () => {
    expect(isValidPathSegment("   ")).toBe(false);
  });

  // --- Invalid: starts with non-alphanumeric ---

  test("rejects leading hyphen", () => {
    expect(isValidPathSegment("-agent")).toBe(false);
  });

  test("rejects leading underscore", () => {
    expect(isValidPathSegment("_agent")).toBe(false);
  });

  // --- Invalid: excessive length ---

  test("accepts segment at POSIX NAME_MAX (255 chars)", () => {
    expect(isValidPathSegment("a".repeat(255))).toBe(true);
  });

  test("rejects segment exceeding POSIX NAME_MAX (256 chars)", () => {
    expect(isValidPathSegment("a".repeat(256))).toBe(false);
  });
});
