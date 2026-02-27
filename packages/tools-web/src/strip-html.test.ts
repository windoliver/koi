import { describe, expect, test } from "bun:test";
import { stripHtml } from "./strip-html.js";

describe("stripHtml", () => {
  test("returns empty string for empty input", () => {
    expect(stripHtml("")).toBe("");
  });

  test("returns plain text unchanged", () => {
    expect(stripHtml("Hello, world!")).toBe("Hello, world!");
  });

  test("strips basic HTML tags", () => {
    expect(stripHtml("<p>Hello</p>")).toBe("Hello");
  });

  test("inserts newlines for block elements", () => {
    const result = stripHtml("<h1>Title</h1><p>Content</p>");
    expect(result).toContain("Title");
    expect(result).toContain("Content");
    // Should have a newline between them
    const lines = result.split("\n").filter((l) => l.trim() !== "");
    expect(lines.length).toBeGreaterThanOrEqual(2);
  });

  test("removes script blocks entirely", () => {
    const html = "<p>Before</p><script>alert('xss')</script><p>After</p>";
    const result = stripHtml(html);
    expect(result).not.toContain("alert");
    expect(result).not.toContain("script");
    expect(result).toContain("Before");
    expect(result).toContain("After");
  });

  test("removes style blocks entirely", () => {
    const html = "<p>Text</p><style>.foo { color: red; }</style>";
    const result = stripHtml(html);
    expect(result).not.toContain("color");
    expect(result).toContain("Text");
  });

  test("decodes common HTML entities", () => {
    expect(stripHtml("&amp; &lt; &gt; &quot;")).toBe('& < > "');
  });

  test("decodes numeric HTML entities", () => {
    expect(stripHtml("&#65;&#66;&#67;")).toBe("ABC");
  });

  test("decodes hex HTML entities", () => {
    expect(stripHtml("&#x41;&#x42;&#x43;")).toBe("ABC");
  });

  test("collapses whitespace", () => {
    const html = "<p>  Hello   world  </p>";
    expect(stripHtml(html)).toBe("Hello world");
  });

  test("removes consecutive empty lines", () => {
    const html = "<p>A</p>\n\n\n\n<p>B</p>";
    const result = stripHtml(html);
    const emptyLines = result.split("\n").filter((l) => l === "").length;
    // Should have at most 1 consecutive empty line
    expect(emptyLines).toBeLessThanOrEqual(2);
  });

  test("handles a realistic HTML page", () => {
    const html = `
      <html>
        <head><title>Test Page</title></head>
        <body>
          <h1>Welcome</h1>
          <p>This is a <strong>test</strong> page.</p>
          <script>console.log("hidden")</script>
          <ul>
            <li>Item 1</li>
            <li>Item 2</li>
          </ul>
        </body>
      </html>
    `;
    const result = stripHtml(html);
    expect(result).toContain("Welcome");
    expect(result).toContain("This is a test page.");
    expect(result).toContain("Item 1");
    expect(result).toContain("Item 2");
    expect(result).not.toContain("console.log");
    expect(result).not.toContain("<");
  });
});
