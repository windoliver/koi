import { describe, expect, test } from "bun:test";
import type { ContentBlock } from "@koi/core";
import { mapContentToPostable } from "./map-content.js";

describe("mapContentToPostable", () => {
  test("maps single TextBlock to markdown", () => {
    const blocks: readonly ContentBlock[] = [{ kind: "text", text: "hello" }];
    const result = mapContentToPostable(blocks);
    expect(result).toEqual({ markdown: "hello" });
  });

  test("maps TextBlock with markdown formatting", () => {
    const blocks: readonly ContentBlock[] = [{ kind: "text", text: "**bold** and _italic_" }];
    const result = mapContentToPostable(blocks);
    expect(result).toEqual({ markdown: "**bold** and _italic_" });
  });

  test("maps multiple TextBlocks by joining with newlines", () => {
    const blocks: readonly ContentBlock[] = [
      { kind: "text", text: "first" },
      { kind: "text", text: "second" },
    ];
    const result = mapContentToPostable(blocks);
    expect(result).toEqual({ markdown: "first\n\nsecond" });
  });

  test("maps TextBlock + ImageBlock", () => {
    const blocks: readonly ContentBlock[] = [
      { kind: "text", text: "check this" },
      { kind: "image", url: "https://example.com/img.png", alt: "a photo" },
    ];
    const result = mapContentToPostable(blocks);
    expect(result).toEqual({
      markdown: "check this\n\n![a photo](https://example.com/img.png)",
    });
  });

  test("maps ImageBlock without alt text", () => {
    const blocks: readonly ContentBlock[] = [{ kind: "image", url: "https://example.com/img.png" }];
    const result = mapContentToPostable(blocks);
    expect(result).toEqual({
      markdown: "![image](https://example.com/img.png)",
    });
  });

  test("maps TextBlock + FileBlock", () => {
    const blocks: readonly ContentBlock[] = [
      { kind: "text", text: "here's the doc" },
      {
        kind: "file",
        url: "https://example.com/doc.pdf",
        mimeType: "application/pdf",
        name: "doc.pdf",
      },
    ];
    const result = mapContentToPostable(blocks);
    expect(result).toEqual({
      markdown: "here's the doc\n\n[doc.pdf](https://example.com/doc.pdf)",
    });
  });

  test("maps FileBlock without name", () => {
    const blocks: readonly ContentBlock[] = [
      { kind: "file", url: "https://example.com/data.bin", mimeType: "application/octet-stream" },
    ];
    const result = mapContentToPostable(blocks);
    expect(result).toEqual({
      markdown: "[file](https://example.com/data.bin)",
    });
  });

  test("maps ButtonBlock as text fallback", () => {
    const blocks: readonly ContentBlock[] = [
      { kind: "text", text: "Choose one:" },
      { kind: "button", label: "Option A", action: "select_a" },
    ];
    const result = mapContentToPostable(blocks);
    expect(result).toEqual({
      markdown: "Choose one:\n\n[Option A]",
    });
  });

  test("skips CustomBlock", () => {
    const blocks: readonly ContentBlock[] = [
      { kind: "text", text: "hello" },
      { kind: "custom", type: "my-widget", data: { foo: 1 } },
    ];
    const result = mapContentToPostable(blocks);
    expect(result).toEqual({ markdown: "hello" });
  });

  test("returns empty markdown for empty content", () => {
    const result = mapContentToPostable([]);
    expect(result).toEqual({ markdown: "" });
  });

  test("returns empty markdown for only custom blocks", () => {
    const blocks: readonly ContentBlock[] = [{ kind: "custom", type: "widget", data: null }];
    const result = mapContentToPostable(blocks);
    expect(result).toEqual({ markdown: "" });
  });
});
