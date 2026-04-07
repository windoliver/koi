/**
 * Tests for healMarkdown — verifies that unclosed markdown formatting
 * markers are appended so partial streaming content renders correctly.
 */

import { describe, expect, test } from "bun:test";
import { healMarkdown } from "./heal-markdown.js";

// ---------------------------------------------------------------------------
// Already complete
// ---------------------------------------------------------------------------

describe("healMarkdown — complete markdown", () => {
  test("empty string returns empty string", () => {
    expect(healMarkdown("")).toBe("");
  });

  test("plain text without formatting returns unchanged", () => {
    expect(healMarkdown("Hello world")).toBe("Hello world");
  });

  test("complete code fence returns unchanged", () => {
    const text = "```js\nconst x = 1;\n```";
    expect(healMarkdown(text)).toBe(text);
  });

  test("complete inline code returns unchanged", () => {
    expect(healMarkdown("use `foo` here")).toBe("use `foo` here");
  });

  test("complete bold returns unchanged", () => {
    expect(healMarkdown("this is **bold** text")).toBe("this is **bold** text");
  });

  test("complete italic returns unchanged", () => {
    expect(healMarkdown("this is *italic* text")).toBe("this is *italic* text");
  });

  test("complete link returns unchanged", () => {
    expect(healMarkdown("[text](https://example.com)")).toBe("[text](https://example.com)");
  });
});

// ---------------------------------------------------------------------------
// Unclosed code fences
// ---------------------------------------------------------------------------

describe("healMarkdown — unclosed code fence", () => {
  test("unclosed fence gets closed", () => {
    const text = "```\nsome code";
    expect(healMarkdown(text)).toBe("```\nsome code\n```");
  });

  test("unclosed fence with language tag gets closed", () => {
    const text = "```typescript\nconst x = 1;";
    expect(healMarkdown(text)).toBe("```typescript\nconst x = 1;\n```");
  });

  test("two fences (one closed, one unclosed) — only last healed", () => {
    const text = "```\na\n```\n```\nb";
    expect(healMarkdown(text)).toBe("```\na\n```\n```\nb\n```");
  });
});

// ---------------------------------------------------------------------------
// Unclosed inline code
// ---------------------------------------------------------------------------

describe("healMarkdown — unclosed inline code", () => {
  test("single unclosed backtick gets closed", () => {
    expect(healMarkdown("use `foo")).toBe("use `foo`");
  });

  test("three backticks on a line are a fence, not inline code", () => {
    // This is a fence scenario, not inline
    const text = "```\ncode";
    const result = healMarkdown(text);
    expect(result).toBe("```\ncode\n```");
  });
});

// ---------------------------------------------------------------------------
// Unclosed bold
// ---------------------------------------------------------------------------

describe("healMarkdown — unclosed bold", () => {
  test("unclosed bold gets closed", () => {
    expect(healMarkdown("this is **bold")).toBe("this is **bold**");
  });

  test("escaped bold marker is not counted", () => {
    expect(healMarkdown("this is \\**text")).toBe("this is \\**text");
  });
});

// ---------------------------------------------------------------------------
// Unclosed italic
// ---------------------------------------------------------------------------

describe("healMarkdown — unclosed italic", () => {
  test("unclosed asterisk italic gets closed", () => {
    expect(healMarkdown("this is *italic")).toBe("this is *italic*");
  });

  test("unclosed underscore italic gets closed", () => {
    expect(healMarkdown("this is _italic")).toBe("this is _italic_");
  });
});

// ---------------------------------------------------------------------------
// Unclosed links
// ---------------------------------------------------------------------------

describe("healMarkdown — unclosed links", () => {
  test("unclosed link URL gets closing paren", () => {
    expect(healMarkdown("[text](https://example.com")).toBe("[text](https://example.com)");
  });

  test("unclosed link text gets closing bracket", () => {
    expect(healMarkdown("[text")).toBe("[text]");
  });

  test("link text with URL partially typed", () => {
    expect(healMarkdown("[text](url")).toBe("[text](url)");
  });
});

// ---------------------------------------------------------------------------
// Multiple unclosed markers
// ---------------------------------------------------------------------------

describe("healMarkdown — multiple unclosed markers", () => {
  test("unclosed bold and italic both get closed", () => {
    const result = healMarkdown("**bold and *italic");
    expect(result).toContain("**");
    expect(result).toContain("*");
    // Should close both
    expect(result).toBe("**bold and *italic***");
  });

  test("unclosed link text and bold", () => {
    const result = healMarkdown("[**link text");
    expect(result).toContain("**");
    expect(result).toContain("]");
  });
});

// ---------------------------------------------------------------------------
// Mixed: unclosed bold inside unclosed code fence
// ---------------------------------------------------------------------------

describe("healMarkdown — mixed scenarios", () => {
  test("unclosed bold inside unclosed code fence — fence takes priority", () => {
    const text = "```\n**bold inside fence";
    const result = healMarkdown(text);
    // The fence gets closed; the bold inside is code so visually fine
    expect(result).toContain("\n```");
  });

  test("multiple complete pairs with no unclosed markers", () => {
    const text = "**bold** and *italic* with `code` and [link](url)\n```\nfenced\n```";
    expect(healMarkdown(text)).toBe(text);
  });
});
