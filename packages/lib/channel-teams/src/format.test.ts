import { describe, expect, test } from "bun:test";
import { formatOutbound } from "./format.js";

describe("formatOutbound", () => {
  test("single text block", () => {
    const r = formatOutbound({ content: [{ kind: "text", text: "hi" }] });
    expect(r).toEqual({ type: "message", text: "hi" });
  });

  test("multiple text blocks joined by blank lines", () => {
    const r = formatOutbound({
      content: [
        { kind: "text", text: "first" },
        { kind: "text", text: "second" },
      ],
    });
    expect(r.text).toBe("first\n\nsecond");
  });

  test("non-text blocks silently dropped", () => {
    const r = formatOutbound({
      content: [
        { kind: "text", text: "kept" },
        { kind: "image", url: "https://x/y.png" },
        { kind: "file", url: "https://x/y.pdf", mimeType: "application/pdf" },
      ],
    });
    expect(r.text).toBe("kept");
  });

  test("zero text blocks yields empty string", () => {
    const r = formatOutbound({ content: [{ kind: "image", url: "https://x" }] });
    expect(r.text).toBe("");
  });
});
