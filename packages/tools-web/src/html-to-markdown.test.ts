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
    expect(htmlToMarkdown("<h2>Sub</h2>")).toContain("## Sub");
    expect(htmlToMarkdown("<h3>Sub3</h3>")).toContain("### Sub3");
  });

  test("converts links", () => {
    const result = htmlToMarkdown('<a href="https://example.com">Click</a>');
    expect(result).toBe("[Click](https://example.com)");
  });

  test("converts bold", () => {
    expect(htmlToMarkdown("<strong>bold</strong>")).toBe("**bold**");
    expect(htmlToMarkdown("<b>bold</b>")).toBe("**bold**");
  });

  test("converts italic", () => {
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
    const result = htmlToMarkdown("<blockquote>A quote</blockquote>");
    expect(result).toContain("> A quote");
  });

  test("converts list items", () => {
    const result = htmlToMarkdown("<ul><li>One</li><li>Two</li></ul>");
    expect(result).toContain("- One");
    expect(result).toContain("- Two");
  });

  test("converts hr to ---", () => {
    expect(htmlToMarkdown("<hr>")).toContain("---");
    expect(htmlToMarkdown("<hr/>")).toContain("---");
  });

  test("removes script blocks", () => {
    const html = "<p>Before</p><script>alert('xss')</script><p>After</p>";
    const result = htmlToMarkdown(html);
    expect(result).not.toContain("alert");
    expect(result).toContain("Before");
    expect(result).toContain("After");
  });

  test("decodes HTML entities", () => {
    expect(htmlToMarkdown("&amp; &lt; &gt;")).toBe("& < >");
  });

  test("handles a realistic page", () => {
    const html = `
      <h1>Welcome</h1>
      <p>This is a <strong>test</strong> page with a <a href="https://link.com">link</a>.</p>
      <ul>
        <li>Item 1</li>
        <li>Item 2</li>
      </ul>
      <blockquote>A wise quote</blockquote>
    `;
    const result = htmlToMarkdown(html);
    expect(result).toContain("# Welcome");
    expect(result).toContain("**test**");
    expect(result).toContain("[link](https://link.com)");
    expect(result).toContain("- Item 1");
    expect(result).toContain("> A wise quote");
  });

  test("collapses excessive whitespace", () => {
    const html = "<p>A</p>\n\n\n\n\n<p>B</p>";
    const result = htmlToMarkdown(html);
    // Should have at most 1 blank line between paragraphs
    expect(result.includes("\n\n\n")).toBe(false);
  });
});
