import { describe, expect, test } from "bun:test";
import { stripHtml } from "./strip-html.js";

describe("stripHtml", () => {
  test("returns empty string for empty input", () => {
    expect(stripHtml("")).toBe("");
  });

  test("returns plain text unchanged", () => {
    expect(stripHtml("Hello, world!")).toBe("Hello, world!");
  });

  test("strips HTML tags", () => {
    expect(stripHtml("<p>Hello</p>")).toBe("Hello");
    expect(stripHtml("<span>text</span>")).toBe("text");
    expect(stripHtml("<a href='#'>link</a>")).toBe("link");
  });

  test("inserts newlines for block elements", () => {
    const result = stripHtml("<p>First</p><p>Second</p>");
    expect(result).toContain("First");
    expect(result).toContain("Second");
    expect(result).toContain("\n");
  });

  test("removes script content entirely", () => {
    const html = "<p>Before</p><script>alert('xss');</script><p>After</p>";
    const result = stripHtml(html);
    expect(result).not.toContain("alert");
    expect(result).not.toContain("script");
    expect(result).toContain("Before");
    expect(result).toContain("After");
  });

  test("removes style content entirely", () => {
    const html = "<p>Text</p><style>.cls { color: red; }</style>";
    const result = stripHtml(html);
    expect(result).not.toContain("color");
    expect(result).not.toContain("style");
    expect(result).toContain("Text");
  });

  test("decodes named HTML entities", () => {
    expect(stripHtml("&amp; &lt; &gt; &quot;")).toBe('& < > "');
    expect(stripHtml("&nbsp;")).toBe("");
    expect(stripHtml("foo&amp;bar")).toBe("foo&bar");
  });

  test("decodes numeric HTML entities", () => {
    // &#65; = A
    expect(stripHtml("&#65;")).toBe("A");
    // &#97; = a
    expect(stripHtml("&#97;")).toBe("a");
  });

  test("decodes hex HTML entities", () => {
    // &#x41; = A
    expect(stripHtml("&#x41;")).toBe("A");
    // &#x61; = a
    expect(stripHtml("&#x61;")).toBe("a");
  });

  test("collapses whitespace", () => {
    expect(stripHtml("  hello    world  ")).toBe("hello world");
    expect(stripHtml("<p>  lots   of   spaces  </p>")).toBe("lots of spaces");
  });

  test("handles realistic HTML page", () => {
    const html = `<!DOCTYPE html>
<html>
<head><title>Test Page</title><style>body { margin: 0; }</style></head>
<body>
  <h1>Welcome</h1>
  <p>This is a <strong>test</strong> page with <a href="/link">a link</a>.</p>
  <script>console.log('hidden');</script>
  <ul>
    <li>Item 1</li>
    <li>Item 2</li>
  </ul>
</body>
</html>`;
    const result = stripHtml(html);
    expect(result).toContain("Welcome");
    expect(result).toContain("test");
    expect(result).toContain("a link");
    expect(result).toContain("Item 1");
    expect(result).toContain("Item 2");
    expect(result).not.toContain("console.log");
    expect(result).not.toContain("margin");
    expect(result).not.toContain("<");
    expect(result).not.toContain(">");
  });
});
