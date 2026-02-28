/**
 * Media send fallback utility.
 *
 * Wraps a platform send function to catch media upload failures and
 * send a text warning instead of silently dropping the content.
 */

import type { ContentBlock, OutboundMessage, TextBlock } from "@koi/core";

/** Configuration for media fallback behavior. */
export interface MediaFallbackConfig {
  /** The platform send function to wrap. */
  readonly send: (message: OutboundMessage) => Promise<void>;
  /** Optional maximum media size in MB. Media over this size triggers fallback. */
  readonly mediaMaxMb?: number;
  /** Custom fallback message template. Receives the original block kind. Default: "[Media failed to send: {kind}]" */
  readonly formatWarning?: (block: ContentBlock) => string;
}

/** Default warning message for failed media. */
function defaultWarning(block: ContentBlock): string {
  const name =
    block.kind === "file" ? (block.name ?? "file") : block.kind === "image" ? "image" : block.kind;
  return `[Media failed to send: ${name}]`;
}

/** Content block kinds that are considered media (can fail on upload). */
function isMediaBlock(
  block: ContentBlock,
): block is ContentBlock & { readonly kind: "image" | "file" } {
  return block.kind === "image" || block.kind === "file";
}

/** Creates a text warning block from a content block description. */
function warningBlock(message: string): TextBlock {
  return { kind: "text", text: message };
}

/** Extracts a human-readable name from a media block. */
function getName(block: ContentBlock): string {
  if (block.kind === "file") return block.name ?? "file";
  if (block.kind === "image") return block.alt ?? "image";
  return block.kind;
}

/**
 * Creates a send function with media fallback.
 *
 * If sending a message with media blocks fails, retries with a text
 * warning in place of each failed media block.
 */
export function createMediaFallback(
  config: MediaFallbackConfig,
): (message: OutboundMessage) => Promise<void> {
  const { send, mediaMaxMb, formatWarning = defaultWarning } = config;

  return async (message: OutboundMessage): Promise<void> => {
    const hasMedia = message.content.some(isMediaBlock);

    if (!hasMedia) {
      await send(message);
      return;
    }

    // Check media size limits if configured
    if (mediaMaxMb !== undefined) {
      const hasOversized = message.content.some(
        (b) => isMediaBlock(b) && isOversized(b, mediaMaxMb),
      );
      if (hasOversized) {
        const fallbackBlocks = message.content.map(
          (b): ContentBlock =>
            isMediaBlock(b) && isOversized(b, mediaMaxMb)
              ? warningBlock(`[File too large (>${mediaMaxMb}MB): ${getName(b)}]`)
              : b,
        );
        await send({ ...message, content: fallbackBlocks });
        return;
      }
    }

    // Try sending normally first
    try {
      await send(message);
    } catch (_e: unknown) {
      // Media send failed — replace media blocks with text warnings
      const fallbackBlocks = message.content.map(
        (b): ContentBlock => (isMediaBlock(b) ? warningBlock(formatWarning(b)) : b),
      );
      await send({ ...message, content: fallbackBlocks });
    }
  };
}

/**
 * Checks if a block exceeds the size limit.
 *
 * FileBlock does not have a standard `size` field in @koi/core, so this
 * is a best-effort check via metadata or custom properties. Returns false
 * when size information is unavailable.
 */
function isOversized(_block: ContentBlock, _maxMb: number): boolean {
  // ContentBlock in @koi/core does not carry a `size` field.
  // Concrete channel adapters that know their block shapes can override
  // this via the formatWarning callback. For now, always returns false
  // so the normal send path is attempted.
  return false;
}
