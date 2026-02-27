/**
 * Channel decorator that intercepts A2UI blocks and replaces them with
 * text links to the Gateway canvas when the inner channel does not
 * support A2UI rendering natively.
 *
 * If the inner channel declares supportsA2ui: true, the decorator is a
 * no-op and returns the inner channel unchanged (zero overhead).
 */

import type { ChannelAdapter, ContentBlock, KoiError, OutboundMessage } from "@koi/core";
import { extractA2uiBlockInfo, isA2uiBlock } from "./detect-a2ui.js";
import type { GatewayClient } from "./gateway-client.js";
import { generateDegradedText, generateSuccessText } from "./generate-fallback-text.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface CanvasFallbackConfig {
  readonly gatewayClient: GatewayClient;
  /** Optional callback invoked when a Gateway call fails. */
  readonly onGatewayError?: (error: KoiError, surfaceId: string) => void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function processBlock(
  block: ContentBlock,
  client: GatewayClient,
  onError: ((error: KoiError, surfaceId: string) => void) | undefined,
): Promise<ContentBlock> {
  if (!isA2uiBlock(block)) return block;

  const info = extractA2uiBlockInfo(block);
  if (info === undefined) return block;

  const serialized = JSON.stringify(info.rawData);

  switch (info.kind) {
    case "createSurface": {
      const result = await client.createSurface(info.surfaceId, serialized);
      if (result.ok) {
        const url = client.computeSurfaceUrl(info.surfaceId);
        return generateSuccessText(info, url);
      }
      onError?.(result.error, info.surfaceId);
      return generateDegradedText(info, result.error.message);
    }
    case "updateComponents":
    case "updateDataModel": {
      const result = await client.updateSurface(info.surfaceId, serialized);
      if (result.ok) {
        const url = client.computeSurfaceUrl(info.surfaceId);
        return generateSuccessText(info, url);
      }
      onError?.(result.error, info.surfaceId);
      return generateDegradedText(info, result.error.message);
    }
    case "deleteSurface": {
      const result = await client.deleteSurface(info.surfaceId);
      if (result.ok) {
        return generateSuccessText(info, "");
      }
      onError?.(result.error, info.surfaceId);
      return generateDegradedText(info, result.error.message);
    }
    default:
      return block;
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Wraps a channel with A2UI-to-canvas fallback behavior.
 *
 * If the inner channel supports A2UI natively, returns it unchanged.
 * Otherwise, intercepts send() to replace A2UI blocks with text links.
 */
export function createCanvasFallbackChannel(
  inner: ChannelAdapter,
  config: CanvasFallbackConfig,
): ChannelAdapter {
  if (inner.capabilities.supportsA2ui) return inner;

  const { gatewayClient, onGatewayError } = config;

  const base = {
    name: inner.name,
    capabilities: inner.capabilities,
    connect: inner.connect,
    disconnect: inner.disconnect,
    onMessage: inner.onMessage,

    async send(message: OutboundMessage): Promise<void> {
      const hasA2ui = message.content.some(isA2uiBlock);
      if (!hasA2ui) {
        await inner.send(message);
        return;
      }

      const processedBlocks: readonly ContentBlock[] = await Promise.all(
        message.content.map((block) => processBlock(block, gatewayClient, onGatewayError)),
      );

      const processed: OutboundMessage = {
        ...message,
        content: processedBlocks,
      };

      await inner.send(processed);
    },
  };

  return inner.sendStatus !== undefined ? { ...base, sendStatus: inner.sendStatus } : base;
}
