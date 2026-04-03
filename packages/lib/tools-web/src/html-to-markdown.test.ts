import { describe, expect, test } from "bun:test";
import { htmlToMarkdown } from "./html-to-markdown.js";

describe("htmlToMarkdown", () => {
  test("returns empty string for empty input", () => {
    expect(htmlToMarkdown("")).toBe("");
  });

  test("returns plain text unchanged", () => {
    expect(htmlToMarkdown("Hello, world!")).toBe("Hello, world!");
  });

  test("converts headings", () => {
    expect(htmlToMarkdown("<h1>Title</h1>")).toContain("# Title");
    expect(htmlToMarkdown("<h2>Subtitle</h2>")).toContain("## Subtitle");
    expect(htmlToMarkdown("<h3>Section</h3>")).toContain("### Section");
  });

  test("converts links", () => {
    const result = htmlToMarkdown('<a href="https://example.com">Example</a>');
    expect(result).toBe("[Example](https://example.com)");
  });

  test("converts bold text", () => {
    expect(htmlToMarkdown("<strong>bold</strong>")).toBe("**bold**");
    expect(htmlToMarkdown("<b>bold</b>")).toBe("**bold**");
  });

  test("converts italic text", () => {
    expect(htmlToMarkdown("<em>italic</em>")).toBe("*italic*");
    expect(htmlToMarkdown("<i>italic</i>")).toBe("*italic*");
  });

  test("converts inline code", () => {
    expect(htmlToMarkdown("<code>foo()</code>")).toBe("`foo()`");
  });

  test("converts pre blocks to fenced code", () => {
    const result = htmlToMarkdown("<pre>const x = 1;</pre>");
    expect(result).toContain("```");
    expect(result).toContain("const x = 1;");
  });

  test("converts blockquotes", () => {
    const result = htmlToMarkdown("<blockquote>A wise quote</blockquote>");
    expect(result).toContain("> A wise quote");
  });

  test("converts list items", () => {
    const result = htmlToMarkdown("<ul><li>First</li><li>Second</li></ul>");
    expect(result).toContain("- First");
    expect(result).toContain("- Second");
  });

  test("converts horizontal rules", () => {
    const result = htmlToMarkdown("<p>Above</p><hr><p>Below</p>");
    expect(result).toContain("---");
    expect(result).toContain("Above");
    expect(result).toContain("Below");
  });

  test("removes script content", () => {
    const html = "<p>Text</p><script>alert('xss');</script>";
    const result = htmlToMarkdown(html);
    expect(result).not.toContain("alert");
    expect(result).toContain("Text");
  });

  test("decodes HTML entities", () => {
    const result = htmlToMarkdown("<p>&amp; &lt; &gt; &quot; &#39;</p>");
    expect(result).toContain("&");
    expect(result).toContain("<");
    expect(result).toContain(">");
    expect(result).toContain('"');
    expect(result).toContain("'");
  });

  test("handles realistic HTML page", () => {
    const html = `<html>
<head><title>Test</title><style>body{}</style></head>
<body>
  <h1>Welcome</h1>
  <p>This is <strong>important</strong> and <em>emphasized</em>.</p>
  <p>Visit <a href="https://example.com">Example</a>.</p>
  <pre>console.log("hello");</pre>
  <ul>
    <li>Item A</li>
    <li>Item B</li>
  </ul>
</body>
</html>`;
    const result = htmlToMarkdown(html);
    expect(result).toContain("Welcome");
    expect(result).toContain("important");
    expect(result).toContain("emphasized");
    expect(result).toContain("[Example](https://example.com)");
    expect(result).toContain("- Item A");
    expect(result).toContain("- Item B");
    expect(result).not.toContain("<");
    expect(result).not.toContain("body{}");
  });

  test("collapses excessive whitespace", () => {
    const result = htmlToMarkdown("<p>  lots   of   spaces  </p>");
    expect(result).not.toMatch(/ {2}/);
  });
});
