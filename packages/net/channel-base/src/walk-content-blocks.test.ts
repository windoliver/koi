import { describe, expect, test } from "bun:test";
import type { ButtonBlock, ContentBlock, CustomBlock, FileBlock, ImageBlock } from "@koi/core";
import { walkContentBlocks } from "./walk-content-blocks.js";

describe("walkContentBlocks", () => {
  test("merges adjacent text blocks with newline", () => {
    const blocks: readonly ContentBlock[] = [
      { kind: "text", text: "hello" },
      { kind: "text", text: "world" },
    ];
    const texts: string[] = [];
    walkContentBlocks(blocks, { onText: (t) => texts.push(t) });
    expect(texts).toEqual(["hello\nworld"]);
  });

  test("flushes text before non-text block", () => {
    const blocks: readonly ContentBlock[] = [
      { kind: "text", text: "intro" },
      { kind: "image", url: "https://example.com/img.png" },
      { kind: "text", text: "outro" },
    ];
    const texts: string[] = [];
    const images: ImageBlock[] = [];
    walkContentBlocks(blocks, {
      onText: (t) => texts.push(t),
      onImage: (b) => images.push(b),
    });
    expect(texts).toEqual(["intro", "outro"]);
    expect(images).toHaveLength(1);
    expect(images[0]?.url).toBe("https://example.com/img.png");
  });

  test("handles all block kinds", () => {
    const blocks: readonly ContentBlock[] = [
      { kind: "text", text: "msg" },
      { kind: "image", url: "img.png" },
      { kind: "file", url: "doc.pdf", mimeType: "application/pdf" },
      { kind: "button", label: "Click", action: "do_thing" },
      { kind: "custom", type: "chart", data: { x: 1 } },
    ];
    const texts: string[] = [];
    const images: ImageBlock[] = [];
    const files: FileBlock[] = [];
    const buttons: ButtonBlock[] = [];
    const customs: CustomBlock[] = [];
    walkContentBlocks(blocks, {
      onText: (t) => texts.push(t),
      onImage: (b) => images.push(b),
      onFile: (b) => files.push(b),
      onButton: (b) => buttons.push(b),
      onCustom: (b) => customs.push(b),
    });
    expect(texts).toEqual(["msg"]);
    expect(images).toHaveLength(1);
    expect(files).toHaveLength(1);
    expect(buttons).toHaveLength(1);
    expect(customs).toHaveLength(1);
  });

  test("handles empty blocks array", () => {
    const texts: string[] = [];
    walkContentBlocks([], { onText: (t) => texts.push(t) });
    expect(texts).toHaveLength(0);
  });

  test("skips block kinds with no callback provided", () => {
    const blocks: readonly ContentBlock[] = [
      { kind: "text", text: "hello" },
      { kind: "image", url: "img.png" },
    ];
    // Only provide onText — image should be silently skipped
    const texts: string[] = [];
    walkContentBlocks(blocks, { onText: (t) => texts.push(t) });
    expect(texts).toEqual(["hello"]);
  });

  test("flushes remaining text at end", () => {
    const blocks: readonly ContentBlock[] = [
      { kind: "image", url: "first.png" },
      { kind: "text", text: "trailing" },
    ];
    const texts: string[] = [];
    walkContentBlocks(blocks, {
      onText: (t) => texts.push(t),
      onImage: () => {},
    });
    expect(texts).toEqual(["trailing"]);
  });

  test("does not flush empty text when no text blocks exist", () => {
    const blocks: readonly ContentBlock[] = [
      { kind: "image", url: "a.png" },
      { kind: "image", url: "b.png" },
    ];
    const texts: string[] = [];
    walkContentBlocks(blocks, {
      onText: (t) => texts.push(t),
      onImage: () => {},
    });
    expect(texts).toHaveLength(0);
  });

  test("text-only input produces single flush", () => {
    const blocks: readonly ContentBlock[] = [
      { kind: "text", text: "a" },
      { kind: "text", text: "b" },
      { kind: "text", text: "c" },
    ];
    const texts: string[] = [];
    walkContentBlocks(blocks, { onText: (t) => texts.push(t) });
    expect(texts).toEqual(["a\nb\nc"]);
  });
});
