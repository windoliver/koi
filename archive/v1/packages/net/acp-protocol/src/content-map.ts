/**
 * Bidirectional content block mapping between Koi and ACP.
 *
 * Koi uses `kind` discriminator; ACP uses `type` discriminator.
 * Some mappings are lossy (e.g., ButtonBlock has no ACP equivalent).
 */

import type { ContentBlock as KoiContentBlock } from "@koi/core";
import type { ContentBlock as AcpContentBlock } from "./acp-schema.js";

// ---------------------------------------------------------------------------
// Koi → ACP
// ---------------------------------------------------------------------------

/**
 * Map Koi ContentBlocks to ACP ContentBlocks.
 *
 * Lossy for:
 * - `ButtonBlock` → skipped (no ACP equivalent)
 * - `CustomBlock` → skipped (no standard ACP representation)
 * - `ImageBlock` → `TextContent` placeholder (Koi uses URL, ACP uses base64)
 */
export function mapKoiContentToAcp(blocks: readonly KoiContentBlock[]): readonly AcpContentBlock[] {
  const result: AcpContentBlock[] = [];

  for (const block of blocks) {
    switch (block.kind) {
      case "text":
        result.push({ type: "text", text: block.text });
        break;

      case "image":
        // Lossy: Koi images are URL-based, ACP images are base64.
        // Emit as text placeholder since we can't fetch/encode at mapping time.
        result.push({
          type: "text",
          text: `[Image: ${block.alt ?? block.url}]`,
        });
        break;

      case "file":
        result.push({
          type: "resourceLink",
          uri: block.url,
          mimeType: block.mimeType,
        });
        break;

      case "button":
        // No ACP equivalent — skip silently
        break;

      case "custom":
        // No standard ACP representation — skip silently
        break;

      default: {
        // Exhaustive check
        const _exhaustive: never = block;
        void _exhaustive;
      }
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// ACP → Koi
// ---------------------------------------------------------------------------

/**
 * Map ACP ContentBlocks to Koi ContentBlocks.
 *
 * - `TextContent` → `TextBlock`
 * - `ImageContent` → `ImageBlock` (data: URI)
 * - `ResourceLinkContent` → `FileBlock`
 * - `EmbeddedResourceContent` → `CustomBlock` wrapper
 */
export function mapAcpContentToKoi(blocks: readonly AcpContentBlock[]): readonly KoiContentBlock[] {
  const result: KoiContentBlock[] = [];

  for (const block of blocks) {
    switch (block.type) {
      case "text":
        result.push({ kind: "text", text: block.text });
        break;

      case "image":
        result.push({
          kind: "image",
          url: `data:${block.mimeType};base64,${block.data}`,
        });
        break;

      case "resourceLink":
        result.push({
          kind: "file",
          url: block.uri,
          mimeType: block.mimeType,
        });
        break;

      case "resource":
        result.push({
          kind: "custom",
          type: "acp:embedded_resource",
          data: {
            uri: block.uri,
            mimeType: block.mimeType,
            text: block.text,
            blob: block.blob,
          },
        });
        break;

      default: {
        // Exhaustive check
        const _exhaustive: never = block;
        void _exhaustive;
      }
    }
  }

  return result;
}
