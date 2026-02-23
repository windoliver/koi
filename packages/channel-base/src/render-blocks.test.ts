/**
 * Table-driven capability matrix tests for renderBlocks().
 *
 * Covers every ContentBlock kind × capability = false case, plus
 * the fast path and mixed-block scenarios.
 */

import { describe, expect, test } from "bun:test";
import type { ChannelCapabilities, ContentBlock } from "@koi/core";
import { renderBlocks } from "./render-blocks.js";

const ALL_CAPS: ChannelCapabilities = {
  text: true,
  images: true,
  files: true,
  buttons: true,
  audio: true,
  video: true,
  threads: true,
};

const NO_CAPS: ChannelCapabilities = {
  text: false,
  images: false,
  files: false,
  buttons: false,
  audio: false,
  video: false,
  threads: false,
};

const imageBlock: ContentBlock = {
  kind: "image",
  url: "https://example.com/cat.png",
  alt: "a cat",
};
const imageNoAlt: ContentBlock = { kind: "image", url: "https://example.com/cat.png" };
const fileBlock: ContentBlock = {
  kind: "file",
  url: "https://example.com/report.pdf",
  mimeType: "application/pdf",
  name: "report.pdf",
};
const fileNoName: ContentBlock = {
  kind: "file",
  url: "https://example.com/report.pdf",
  mimeType: "application/pdf",
};
const buttonBlock: ContentBlock = { kind: "button", label: "Click me", action: "click" };
const textBlock: ContentBlock = { kind: "text", text: "Hello" };
const customBlock: ContentBlock = { kind: "custom", type: "chart", data: { x: 1 } };

describe("renderBlocks", () => {
  describe("fast path — returns same reference when all renderable capabilities are true", () => {
    test("returns same reference when images + files + buttons are true", () => {
      const blocks = [imageBlock, fileBlock, buttonBlock];
      const result = renderBlocks(blocks, ALL_CAPS);
      expect(result).toBe(blocks); // same reference, zero allocation
    });

    test("returns same reference even with no-capability fields (audio, video) false", () => {
      const caps: ChannelCapabilities = {
        ...ALL_CAPS,
        audio: false,
        video: false,
        threads: false,
      };
      const blocks = [textBlock];
      expect(renderBlocks(blocks, caps)).toBe(blocks);
    });
  });

  describe("image block downgrade", () => {
    test("image with alt is downgraded to [Image: alt] when images: false", () => {
      const result = renderBlocks([imageBlock], NO_CAPS);
      expect(result).toEqual([{ kind: "text", text: "[Image: a cat]" }]);
    });

    test("image without alt falls back to URL when images: false", () => {
      const result = renderBlocks([imageNoAlt], NO_CAPS);
      expect(result).toEqual([{ kind: "text", text: "[Image: https://example.com/cat.png]" }]);
    });

    test("image is unchanged when images: true", () => {
      const result = renderBlocks([imageBlock], ALL_CAPS);
      expect(result[0]).toBe(imageBlock);
    });
  });

  describe("file block downgrade", () => {
    test("file with name is downgraded to [File: name] when files: false", () => {
      const result = renderBlocks([fileBlock], NO_CAPS);
      expect(result).toEqual([{ kind: "text", text: "[File: report.pdf]" }]);
    });

    test("file without name falls back to URL when files: false", () => {
      const result = renderBlocks([fileNoName], NO_CAPS);
      expect(result).toEqual([{ kind: "text", text: "[File: https://example.com/report.pdf]" }]);
    });

    test("file is unchanged when files: true", () => {
      const result = renderBlocks([fileBlock], ALL_CAPS);
      expect(result[0]).toBe(fileBlock);
    });
  });

  describe("button block downgrade", () => {
    test("button is downgraded to [label] when buttons: false", () => {
      const result = renderBlocks([buttonBlock], NO_CAPS);
      expect(result).toEqual([{ kind: "text", text: "[Click me]" }]);
    });

    test("button is unchanged when buttons: true", () => {
      const result = renderBlocks([buttonBlock], ALL_CAPS);
      expect(result[0]).toBe(buttonBlock);
    });
  });

  describe("text block — always unchanged", () => {
    test("text block is never downgraded regardless of capabilities", () => {
      const result = renderBlocks([textBlock], NO_CAPS);
      expect(result[0]).toBe(textBlock);
    });
  });

  describe("custom block — always passes through", () => {
    test("custom block is never downgraded (no capability flag)", () => {
      const result = renderBlocks([customBlock], NO_CAPS);
      expect(result[0]).toBe(customBlock);
    });
  });

  describe("mixed blocks with partial capabilities", () => {
    test("only unsupported blocks are downgraded in mixed content", () => {
      const caps: ChannelCapabilities = { ...NO_CAPS, images: true }; // images supported, files/buttons not
      const blocks: ContentBlock[] = [imageBlock, fileBlock, buttonBlock, textBlock];
      const result = renderBlocks(blocks, caps);

      expect(result[0]).toBe(imageBlock); // unchanged
      expect(result[1]).toEqual({ kind: "text", text: "[File: report.pdf]" }); // downgraded
      expect(result[2]).toEqual({ kind: "text", text: "[Click me]" }); // downgraded
      expect(result[3]).toBe(textBlock); // unchanged
    });
  });

  describe("empty blocks", () => {
    test("returns empty array for empty input", () => {
      const result = renderBlocks([], NO_CAPS);
      expect(result).toEqual([]);
    });
  });
});
