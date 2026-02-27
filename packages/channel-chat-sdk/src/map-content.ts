/**
 * Content mapper: Koi ContentBlock[] → Chat SDK AdapterPostableMessage.
 *
 * Converts Koi's rich content blocks into a markdown string suitable
 * for the Chat SDK's `postMessage()`. Images and files are embedded
 * as markdown links; buttons degrade to `[label]` text; custom blocks
 * are silently skipped (no platform mapping).
 */

import type { ContentBlock } from "@koi/core";

/**
 * Maps a single ContentBlock to its markdown representation, or null
 * for unmappable blocks (custom).
 */
function blockToMarkdown(block: ContentBlock): string | null {
  switch (block.kind) {
    case "text":
      return block.text;
    case "image": {
      const alt = block.alt ?? "image";
      return `![${alt}](${block.url})`;
    }
    case "file": {
      const name = block.name ?? "file";
      return `[${name}](${block.url})`;
    }
    case "button":
      return `[${block.label}]`;
    case "custom":
      return null;
  }
}

/**
 * Maps Koi ContentBlock[] to a Chat SDK AdapterPostableMessage.
 *
 * Returns a `{ markdown: string }` object that all Chat SDK adapters
 * accept natively. In v2, this may return richer card-based messages.
 */
export function mapContentToPostable(content: readonly ContentBlock[]): {
  readonly markdown: string;
} {
  const parts: string[] = [];

  for (const block of content) {
    const md = blockToMarkdown(block);
    if (md !== null) {
      parts.push(md);
    }
  }

  return { markdown: parts.join("\n\n") };
}
