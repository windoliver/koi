/**
 * TextBlock unit tests.
 *
 * Tests cover both branches:
 * - Plain text (no syntaxStyle) — uses <text> fallback
 * - Markdown-highlighted (with syntaxStyle) — uses <markdown> component
 */

import { SyntaxStyle } from "@opentui/core";
import { testRender } from "@opentui/solid";
import { describe, expect, test } from "bun:test";
import { TextBlock } from "./text-block.js";

const OPTS = { width: 80, height: 24 };

async function renderTextBlock(props: {
  readonly text: string;
  readonly streaming?: boolean | undefined;
  readonly syntaxStyle?: SyntaxStyle | undefined;
}): Promise<string> {
  const { captureCharFrame, renderOnce, renderer } = await testRender(
    () => (
      <TextBlock
        text={props.text}
        streaming={props.streaming}
        syntaxStyle={props.syntaxStyle}
      />
    ),
    OPTS,
  );
  await renderOnce();
  const frame = captureCharFrame();
  renderer.destroy();
  return frame;
}

// ---------------------------------------------------------------------------
// Plain text (no syntaxStyle) — <text> fallback
// ---------------------------------------------------------------------------

describe("TextBlock — plain text (no syntaxStyle)", () => {
  test("renders text content", async () => {
    const frame = await renderTextBlock({ text: "hello world" });
    expect(frame).toContain("hello world");
  });

  test("renders empty string without crash", async () => {
    const frame = await renderTextBlock({ text: "" });
    expect(typeof frame).toBe("string");
  });

  test("renders text with streaming=true (falls back to plain text)", async () => {
    const frame = await renderTextBlock({ text: "partial...", streaming: true });
    expect(frame).toContain("partial...");
  });

  test("renders text with streaming=false", async () => {
    const frame = await renderTextBlock({ text: "complete response", streaming: false });
    expect(frame).toContain("complete response");
  });

  test("renders multi-line text", async () => {
    const frame = await renderTextBlock({ text: "line one\nline two" });
    expect(frame).toContain("line one");
  });
});

// ---------------------------------------------------------------------------
// Markdown-highlighted (with syntaxStyle) — <markdown> branch
// ---------------------------------------------------------------------------

describe("TextBlock — with syntaxStyle (markdown branch)", () => {
  // SyntaxStyle.create() produces a default style with no theme tokens.
  // Note: <markdown> in test mode (no treeSitterClient) renders code fence
  // content via CodeRenderable but does NOT render paragraph/heading text,
  // which requires the tree-sitter WASM parser. Tests assert what actually
  // renders in this constrained environment.
  const syntaxStyle = SyntaxStyle.create();

  test("renders without crash for plain text", async () => {
    // Exercises the <markdown> branch — doesn't crash, returns a string.
    // Paragraph text requires tree-sitter (not loaded in unit tests).
    const frame = await renderTextBlock({ text: "hello world", syntaxStyle });
    expect(typeof frame).toBe("string");
  });

  test("renders empty string without crash", async () => {
    const frame = await renderTextBlock({ text: "", syntaxStyle });
    expect(typeof frame).toBe("string");
  });

  test("streaming=true renders code fence content", async () => {
    // Unclosed code fence — a real LLM streaming pattern.
    // Code block content renders without tree-sitter; pre-fence paragraph text does not.
    const frame = await renderTextBlock({
      text: "Here is some code:\n```ts\nconst x =",
      syntaxStyle,
      streaming: true,
    });
    expect(frame).toContain("const x =");
  });

  test("streaming=false renders complete code fence content", async () => {
    const frame = await renderTextBlock({
      text: "```ts\nconst x = 1;\n```",
      syntaxStyle,
      streaming: false,
    });
    expect(frame).toContain("const x = 1;");
  });

  test("multi-line content renders without crash", async () => {
    // Markdown headings and paragraphs require tree-sitter; just verify no crash.
    const frame = await renderTextBlock({
      text: "# Heading\n\nParagraph text here.",
      syntaxStyle,
    });
    expect(typeof frame).toBe("string");
  });
});
