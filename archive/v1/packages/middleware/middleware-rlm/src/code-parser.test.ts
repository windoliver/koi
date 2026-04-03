/**
 * Tests for code block parser.
 */

import { describe, expect, test } from "bun:test";
import { extractCodeBlock } from "./code-parser.js";

describe("extractCodeBlock", () => {
  test("extracts javascript code block", () => {
    const text = 'Here is my code:\n\n```javascript\nconsole.log("hello");\n```\n\nDone.';
    const result = extractCodeBlock(text);
    expect(result).toEqual({ language: "javascript", code: 'console.log("hello");' });
  });

  test("extracts js shorthand code block", () => {
    const text = "```js\nvar x = 1;\n```";
    const result = extractCodeBlock(text);
    expect(result).toEqual({ language: "js", code: "var x = 1;" });
  });

  test("returns undefined for non-js code blocks", () => {
    const text = '```python\nprint("hello")\n```';
    expect(extractCodeBlock(text)).toBeUndefined();
  });

  test("returns undefined for no code blocks", () => {
    const text = "Here is my analysis:\n\nThe data shows a clear pattern.";
    expect(extractCodeBlock(text)).toBeUndefined();
  });

  test("extracts first matching block when multiple exist", () => {
    const text = "```javascript\nvar a = 1;\n```\n\n```javascript\nvar b = 2;\n```";
    const result = extractCodeBlock(text);
    expect(result).toEqual({ language: "javascript", code: "var a = 1;" });
  });

  test("returns undefined for empty code block", () => {
    const text = "```javascript\n   \n```";
    expect(extractCodeBlock(text)).toBeUndefined();
  });

  test("handles multiline code", () => {
    const text = "```javascript\nvar x = 1;\nconsole.log(x);\nvar y = x + 1;\n```";
    const result = extractCodeBlock(text);
    expect(result).toEqual({
      language: "javascript",
      code: "var x = 1;\nconsole.log(x);\nvar y = x + 1;",
    });
  });

  test("skips non-js blocks and finds js block after them", () => {
    const text = '```python\nprint("hi")\n```\n\nNow some JS:\n\n```javascript\nvar z = 3;\n```';
    const result = extractCodeBlock(text);
    expect(result).toEqual({ language: "javascript", code: "var z = 3;" });
  });

  test("handles case-insensitive language tag", () => {
    const text = '```JavaScript\nconsole.log("hi");\n```';
    const result = extractCodeBlock(text);
    expect(result).toEqual({ language: "javascript", code: 'console.log("hi");' });
  });
});
