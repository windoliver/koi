import { describe, expect, test } from "bun:test";
import { stripAnsi } from "./ansi.js";

describe("stripAnsi", () => {
  test("strips color codes", () => {
    expect(stripAnsi("\x1b[31mred\x1b[0m")).toBe("red");
  });

  test("strips bold/underline", () => {
    expect(stripAnsi("\x1b[1mbold\x1b[22m \x1b[4munderline\x1b[24m")).toBe("bold underline");
  });

  test("strips cursor movement", () => {
    expect(stripAnsi("\x1b[2J\x1b[Hhello")).toBe("hello");
  });

  test("strips OSC sequences", () => {
    expect(stripAnsi("\x1b]0;title\x07content")).toBe("content");
  });

  test("returns plain text unchanged", () => {
    expect(stripAnsi("hello world")).toBe("hello world");
  });

  test("handles empty string", () => {
    expect(stripAnsi("")).toBe("");
  });

  test("strips 256-color codes", () => {
    expect(stripAnsi("\x1b[38;5;196mred256\x1b[0m")).toBe("red256");
  });
});
