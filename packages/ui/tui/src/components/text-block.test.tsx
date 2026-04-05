/**
 * TextBlock unit tests.
 */

import { testRender } from "@opentui/solid";
import { describe, expect, test } from "bun:test";
import { TextBlock } from "./text-block.js";

const OPTS = { width: 80, height: 24 };

async function renderTextBlock(props: {
  readonly text: string;
  readonly streaming?: boolean | undefined;
}): Promise<string> {
  const { captureCharFrame, renderOnce, renderer } = await testRender(
    () => <TextBlock text={props.text} streaming={props.streaming} />,
    OPTS,
  );
  await renderOnce();
  const frame = captureCharFrame();
  renderer.destroy();
  return frame;
}

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
