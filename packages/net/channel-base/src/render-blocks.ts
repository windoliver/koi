/**
 * Capability-aware ContentBlock renderer.
 *
 * Downgrades unsupported block types to TextBlock fallbacks based on the
 * channel's declared capabilities. Returns the same array reference if no
 * downgrade is needed (fast path — zero allocation).
 *
 * Note: audio, video, and threads capabilities currently have no corresponding
 * ContentBlock types. Custom blocks are always passed through unchanged.
 */

import type { ChannelCapabilities, ContentBlock, TextBlock } from "@koi/core";

/**
 * Downgrades blocks that exceed the channel's declared capabilities.
 *
 * Fast path: if all capabilities with corresponding block types are true
 * (images, files, buttons), returns the original array reference unchanged.
 */
export function renderBlocks(
  blocks: readonly ContentBlock[],
  capabilities: ChannelCapabilities,
): readonly ContentBlock[] {
  // Fast path: all currently renderable capabilities are satisfied.
  // audio/video/threads have no corresponding ContentBlock types yet.
  if (capabilities.images && capabilities.files && capabilities.buttons) {
    return blocks;
  }

  return blocks.map((block) => downgrade(block, capabilities));
}

function downgrade(block: ContentBlock, capabilities: ChannelCapabilities): ContentBlock {
  switch (block.kind) {
    case "image":
      return capabilities.images ? block : fallback(`[Image: ${block.alt ?? block.url}]`);
    case "file":
      return capabilities.files ? block : fallback(`[File: ${block.name ?? block.url}]`);
    case "button":
      return capabilities.buttons ? block : fallback(`[${block.label}]`);
    case "text":
    case "custom":
      // text: always supported. custom: no capability flag — always pass through.
      return block;
  }
}

function fallback(description: string): TextBlock {
  return { kind: "text", text: description };
}
