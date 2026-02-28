import { describe, expect, test } from "bun:test";
import { mapTextToSlackMrkdwn } from "./format.js";

describe("mapTextToSlackMrkdwn", () => {
  test("converts bold **text** to *text*", () => {
    expect(mapTextToSlackMrkdwn("This is **bold** text")).toBe("This is *bold* text");
  });

  test("converts bold __text__ to *text*", () => {
    expect(mapTextToSlackMrkdwn("This is __bold__ text")).toBe("This is *bold* text");
  });

  test("converts strikethrough ~~text~~ to ~text~", () => {
    expect(mapTextToSlackMrkdwn("This is ~~struck~~ text")).toBe("This is ~struck~ text");
  });

  test("converts links [text](url) to <url|text>", () => {
    expect(mapTextToSlackMrkdwn("Visit [Koi](https://koi.dev)")).toBe(
      "Visit <https://koi.dev|Koi>",
    );
  });

  test("preserves code blocks", () => {
    const input = "```\nconst x = 1;\n```";
    expect(mapTextToSlackMrkdwn(input)).toBe(input);
  });

  test("preserves inline code", () => {
    const input = "Use `const` instead";
    expect(mapTextToSlackMrkdwn(input)).toBe(input);
  });

  test("preserves blockquotes", () => {
    const input = "> This is a quote";
    expect(mapTextToSlackMrkdwn(input)).toBe(input);
  });

  test("handles multiple transformations in one string", () => {
    const input = "**bold** and ~~strike~~ with [link](https://example.com)";
    expect(mapTextToSlackMrkdwn(input)).toBe("*bold* and ~strike~ with <https://example.com|link>");
  });

  test("passes through plain text unchanged", () => {
    const input = "Hello, world!";
    expect(mapTextToSlackMrkdwn(input)).toBe(input);
  });
});
