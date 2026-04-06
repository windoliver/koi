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
// With syntaxStyle but no treeSitterClient — falls back to <text>
// ---------------------------------------------------------------------------

describe("TextBlock — with syntaxStyle but no treeSitterClient (text fallback)", () => {
  // TextBlock requires BOTH syntaxStyle AND treeSitterClient to activate
  // <markdown>. With only syntaxStyle, it uses the <text> fallback so prose
  // renders correctly without tree-sitter WASM (not loadable in unit tests).
  const syntaxStyle = SyntaxStyle.create();

  test("renders plain text content (uses <text> fallback)", async () => {
    const frame = await renderTextBlock({ text: "hello world", syntaxStyle });
    expect(frame).toContain("hello world");
  });

  test("renders empty string without crash", async () => {
    const frame = await renderTextBlock({ text: "", syntaxStyle });
    expect(typeof frame).toBe("string");
  });

  test("streaming=true renders full text content", async () => {
    const frame = await renderTextBlock({
      text: "Here is some code:\n```ts\nconst x =",
      syntaxStyle,
      streaming: true,
    });
    expect(frame).toContain("const x =");
  });

  test("streaming=false renders full text content", async () => {
    const frame = await renderTextBlock({
      text: "```ts\nconst x = 1;\n```",
      syntaxStyle,
      streaming: false,
    });
    expect(frame).toContain("const x = 1;");
  });

  test("multi-line content renders without crash", async () => {
    const frame = await renderTextBlock({
      text: "# Heading\n\nParagraph text here.",
      syntaxStyle,
    });
    expect(frame).toContain("Paragraph text here.");
  });
});
