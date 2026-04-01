import { describe, expect, test } from "bun:test";
import type { ChannelCapabilities, ContentBlock } from "@koi/core";
import { renderBlocks } from "./render-blocks.js";

const ALL_TRUE: ChannelCapabilities = {
  text: true,
  images: true,
  files: true,
  buttons: true,
  audio: true,
  video: true,
  threads: true,
  supportsA2ui: true,
};

const TEXT_ONLY: ChannelCapabilities = {
  text: true,
  images: false,
  files: false,
  buttons: false,
  audio: false,
  video: false,
  threads: false,
  supportsA2ui: false,
};

describe("renderBlocks", () => {
  describe("fast path", () => {
    test("returns same reference when all renderable capabilities are true", () => {
      const blocks: readonly ContentBlock[] = [
        { kind: "text", text: "hello" },
        { kind: "image", url: "https://example.com/pic.png", alt: "pic" },
      ];
      const result = renderBlocks(blocks, ALL_TRUE);
      expect(result).toBe(blocks);
    });

    test("returns same reference even with false audio/video (no block types for these)", () => {
      const caps: ChannelCapabilities = {
        ...ALL_TRUE,
        audio: false,
        video: false,
        threads: false,
      };
      const blocks: readonly ContentBlock[] = [{ kind: "text", text: "hello" }];
      const result = renderBlocks(blocks, caps);
      expect(result).toBe(blocks);
    });
  });

  describe("image downgrade", () => {
    test("downgrades to alt text when images not supported", () => {
      const blocks: readonly ContentBlock[] = [
        { kind: "image", url: "https://example.com/pic.png", alt: "a cat" },
      ];
      const result = renderBlocks(blocks, TEXT_ONLY);
      expect(result).toEqual([{ kind: "text", text: "[Image: a cat]" }]);
    });

    test("falls back to url when no alt text", () => {
      const blocks: readonly ContentBlock[] = [
        { kind: "image", url: "https://example.com/pic.png" },
      ];
      const result = renderBlocks(blocks, TEXT_ONLY);
      expect(result).toEqual([{ kind: "text", text: "[Image: https://example.com/pic.png]" }]);
    });

    test("unchanged when images capability is true", () => {
      const caps: ChannelCapabilities = { ...TEXT_ONLY, images: true };
      const block: ContentBlock = {
        kind: "image",
        url: "https://example.com/pic.png",
        alt: "pic",
      };
      const result = renderBlocks([block], caps);
      expect(result[0]).toBe(block);
    });
  });

  describe("file downgrade", () => {
    test("downgrades to file name when files not supported", () => {
      const blocks: readonly ContentBlock[] = [
        {
          kind: "file",
          url: "https://example.com/doc.pdf",
          mimeType: "application/pdf",
          name: "report.pdf",
        },
      ];
      const result = renderBlocks(blocks, TEXT_ONLY);
      expect(result).toEqual([{ kind: "text", text: "[File: report.pdf]" }]);
    });

    test("falls back to url when no name", () => {
      const blocks: readonly ContentBlock[] = [
        { kind: "file", url: "https://example.com/doc.pdf", mimeType: "application/pdf" },
      ];
      const result = renderBlocks(blocks, TEXT_ONLY);
      expect(result).toEqual([{ kind: "text", text: "[File: https://example.com/doc.pdf]" }]);
    });
  });

  describe("button downgrade", () => {
    test("downgrades to label when buttons not supported", () => {
      const blocks: readonly ContentBlock[] = [
        { kind: "button", label: "Click me", action: "submit" },
      ];
      const result = renderBlocks(blocks, TEXT_ONLY);
      expect(result).toEqual([{ kind: "text", text: "[Click me]" }]);
    });
  });

  describe("passthrough", () => {
    test("text blocks are never downgraded", () => {
      const block: ContentBlock = { kind: "text", text: "hello" };
      const result = renderBlocks([block], TEXT_ONLY);
      expect(result[0]).toBe(block);
    });

    test("custom blocks always pass through (no capability flag)", () => {
      const block: ContentBlock = { kind: "custom", type: "chart", data: { x: 1 } };
      const result = renderBlocks([block], TEXT_ONLY);
      expect(result[0]).toBe(block);
    });
  });

  describe("mixed content", () => {
    test("only unsupported blocks are downgraded", () => {
      const textBlock: ContentBlock = { kind: "text", text: "hello" };
      const imageBlock: ContentBlock = { kind: "image", url: "pic.png", alt: "pic" };
      const result = renderBlocks([textBlock, imageBlock], TEXT_ONLY);
      expect(result[0]).toBe(textBlock);
      expect(result[1]).toEqual({ kind: "text", text: "[Image: pic]" });
    });
  });

  test("empty blocks array returns empty array", () => {
    const result = renderBlocks([], TEXT_ONLY);
    expect(result).toEqual([]);
  });
});
