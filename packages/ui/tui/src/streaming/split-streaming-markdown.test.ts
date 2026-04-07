/**
 * Tests for splitStreamingMarkdown — verifies stable/tail splitting
 * at the last unclosed code fence boundary.
 */

import { describe, expect, test } from "bun:test";
import { splitStreamingMarkdown } from "./split-streaming-markdown.js";

// ---------------------------------------------------------------------------
// No fences
// ---------------------------------------------------------------------------

describe("splitStreamingMarkdown — no fences", () => {
  test("empty text returns both parts empty", () => {
    const result = splitStreamingMarkdown("");
    expect(result).toEqual({ stable: "", tail: "" });
  });

  test("plain text with no fences returns full text as stable", () => {
    const text = "Hello world\nThis is plain markdown.";
    const result = splitStreamingMarkdown(text);
    expect(result).toEqual({ stable: text, tail: "" });
  });

  test("inline backticks are not treated as fences", () => {
    const text = "Use `code` inline and ``double`` too.";
    const result = splitStreamingMarkdown(text);
    expect(result).toEqual({ stable: text, tail: "" });
  });

  test("backticks not at start of line are not fences", () => {
    const text = "some text ``` not a fence";
    const result = splitStreamingMarkdown(text);
    expect(result).toEqual({ stable: text, tail: "" });
  });
});

// ---------------------------------------------------------------------------
// Complete (closed) fences
// ---------------------------------------------------------------------------

describe("splitStreamingMarkdown — closed fences", () => {
  test("single complete code block returns full text as stable", () => {
    const text = "before\n```\ncode\n```\nafter";
    const result = splitStreamingMarkdown(text);
    expect(result).toEqual({ stable: text, tail: "" });
  });

  test("multiple complete code blocks returns full text as stable", () => {
    const text = "```js\nfoo();\n```\n\n```ts\nbar();\n```\n";
    const result = splitStreamingMarkdown(text);
    expect(result).toEqual({ stable: text, tail: "" });
  });
});

// ---------------------------------------------------------------------------
// Unclosed fences
// ---------------------------------------------------------------------------

describe("splitStreamingMarkdown — unclosed fences", () => {
  test("single unclosed fence splits at the fence", () => {
    const text = "before\n```\nstreaming code";
    const result = splitStreamingMarkdown(text);
    expect(result.stable).toBe("before\n");
    expect(result.tail).toBe("```\nstreaming code");
  });

  test("unclosed fence with language tag", () => {
    const text = "before\n```typescript\nconst x = 1;";
    const result = splitStreamingMarkdown(text);
    expect(result.stable).toBe("before\n");
    expect(result.tail).toBe("```typescript\nconst x = 1;");
  });

  test("fence at start of text", () => {
    const text = "```\ncode here";
    const result = splitStreamingMarkdown(text);
    expect(result.stable).toBe("");
    expect(result.tail).toBe("```\ncode here");
  });

  test("text with only the fence marker and no content after", () => {
    const text = "before\n```";
    const result = splitStreamingMarkdown(text);
    expect(result.stable).toBe("before\n");
    expect(result.tail).toBe("```");
  });

  test("multiple fences, last one unclosed", () => {
    const text = "```js\nfoo();\n```\n\ntext\n```py\nbar()";
    const result = splitStreamingMarkdown(text);
    expect(result.stable).toBe("```js\nfoo();\n```\n\ntext\n");
    expect(result.tail).toBe("```py\nbar()");
  });

  test("multiple fences, all closed", () => {
    const text = "```\na\n```\n```\nb\n```\n";
    const result = splitStreamingMarkdown(text);
    expect(result).toEqual({ stable: text, tail: "" });
  });

  test("fence with content after it", () => {
    const text = 'intro\n```json\n{"key": "value"}\nmore lines\nstill going';
    const result = splitStreamingMarkdown(text);
    expect(result.stable).toBe("intro\n");
    expect(result.tail).toBe('```json\n{"key": "value"}\nmore lines\nstill going');
  });
});

// ---------------------------------------------------------------------------
// Nested / 4-backtick fences
// ---------------------------------------------------------------------------

describe("splitStreamingMarkdown — nested fences", () => {
  test("4-backtick fence closed by 4-backtick fence", () => {
    const text = "````\ninner\n````\nafter";
    const result = splitStreamingMarkdown(text);
    expect(result).toEqual({ stable: text, tail: "" });
  });

  test("unclosed 4-backtick fence splits at the fence", () => {
    const text = "before\n````\ninner content";
    const result = splitStreamingMarkdown(text);
    expect(result.stable).toBe("before\n");
    expect(result.tail).toBe("````\ninner content");
  });

  test("3-backtick fence inside 4-backtick fence is not a closer", () => {
    // ```` opens, ``` cannot close it (width 3 < 4), so still unclosed
    const text = "````\ninner\n```\nstill inside";
    const result = splitStreamingMarkdown(text);
    expect(result.stable).toBe("");
    expect(result.tail).toBe("````\ninner\n```\nstill inside");
  });

  test("4-backtick fence closes a 3-backtick fence (width >= opener)", () => {
    // ``` opens, ```` closes it (width 4 >= 3)
    const text = "```\ninner\n````\nafter";
    const result = splitStreamingMarkdown(text);
    expect(result).toEqual({ stable: text, tail: "" });
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("splitStreamingMarkdown — edge cases", () => {
  test("stable + tail concatenated equals original text", () => {
    const text = "# Title\n\n```ts\nconst x = 1;\n```\n\nParagraph\n```py\nimport os";
    const result = splitStreamingMarkdown(text);
    expect(result.stable + result.tail).toBe(text);
  });

  test("fence-only text (no surrounding content)", () => {
    const text = "```";
    const result = splitStreamingMarkdown(text);
    expect(result.stable).toBe("");
    expect(result.tail).toBe("```");
  });

  test("two backticks on a line are not a fence", () => {
    const text = "``\nnot a fence\n``";
    const result = splitStreamingMarkdown(text);
    expect(result).toEqual({ stable: text, tail: "" });
  });
});
