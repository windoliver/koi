import { describe, expect, test } from "bun:test";
import { mapTextToHtml } from "./format.js";

describe("mapTextToHtml", () => {
  test("wraps text in HTML template", () => {
    const result = mapTextToHtml("Hello");
    expect(result).toContain("<!DOCTYPE html>");
    expect(result).toContain("Hello");
    expect(result).toContain("</body>");
  });

  test("converts newlines to <br>", () => {
    const result = mapTextToHtml("line1\nline2");
    expect(result).toContain("line1<br>");
  });

  test("converts **bold** to <strong>", () => {
    const result = mapTextToHtml("This is **bold** text");
    expect(result).toContain("<strong>bold</strong>");
  });

  test("converts *italic* to <em>", () => {
    const result = mapTextToHtml("This is *italic* text");
    expect(result).toContain("<em>italic</em>");
  });

  test("converts [text](url) to <a> tag", () => {
    const result = mapTextToHtml("Visit [Koi](https://koi.dev)");
    expect(result).toContain('<a href="https://koi.dev"');
    expect(result).toContain("Koi</a>");
  });

  test("converts `code` to <code>", () => {
    const result = mapTextToHtml("Use `const` here");
    expect(result).toContain("<code>const</code>");
  });

  test("escapes HTML entities", () => {
    const result = mapTextToHtml("1 < 2 & 3 > 2");
    expect(result).toContain("1 &lt; 2 &amp; 3 &gt; 2");
  });

  test("escapes quotes", () => {
    const result = mapTextToHtml('He said "hello"');
    expect(result).toContain("&quot;hello&quot;");
  });

  test("handles empty text", () => {
    const result = mapTextToHtml("");
    expect(result).toContain("<!DOCTYPE html>");
  });

  test("handles multiple transformations", () => {
    const result = mapTextToHtml("**bold** and *italic* with [link](https://example.com)");
    expect(result).toContain("<strong>bold</strong>");
    expect(result).toContain("<em>italic</em>");
    expect(result).toContain('<a href="https://example.com"');
  });
});
