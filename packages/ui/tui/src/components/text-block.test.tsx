/**
 * TextBlock unit tests.
 *
 * Tests cover both branches:
 * - Plain text (no syntaxStyle) — uses <text> fallback
 * - Markdown-highlighted (with syntaxStyle) — uses <markdown> component
 */

import type { SyntaxStyle } from "@opentui/core";
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
  // SyntaxStyle.create() produces a default style with no theme tokens,
  // sufficient to exercise the <markdown> branch without loading tree-sitter.
  const syntaxStyle = SyntaxStyle.create();

  test("renders text content via markdown branch", async () => {
    const frame = await renderTextBlock({ text: "hello world", syntaxStyle });
    expect(frame).toContain("hello world");
  });

  test("renders empty string without crash", async () => {
    const frame = await renderTextBlock({ text: "", syntaxStyle });
    expect(typeof frame).toBe("string");
  });

  test("streaming=true renders content without finalizing incomplete syntax", async () => {
    // Unclosed code fence — a real LLM streaming pattern.
    // streaming=true tells <markdown> not to finalize, so the raw text should
    // appear rather than being swallowed by incomplete-parse handling.
    const frame = await renderTextBlock({
      text: "Here is some code:\n```ts\nconst x =",
      syntaxStyle,
      streaming: true,
    });
    expect(frame).toContain("Here is some code:");
  });

  test("streaming=false renders complete content normally", async () => {
    const frame = await renderTextBlock({
      text: "```ts\nconst x = 1;\n```",
      syntaxStyle,
      streaming: false,
    });
    expect(frame).toContain("const x = 1;");
  });

  test("multi-line content renders all lines", async () => {
    const frame = await renderTextBlock({
      text: "# Heading\n\nParagraph text here.",
      syntaxStyle,
    });
    expect(frame).toContain("Heading");
    expect(frame).toContain("Paragraph text here.");
  });
});
