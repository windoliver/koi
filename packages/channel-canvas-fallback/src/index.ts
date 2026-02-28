/**
 * @koi/channel-canvas-fallback — A2UI surface fallback for text-only channels.
 *
 * Decorates any ChannelAdapter to automatically replace A2UI content blocks
 * with text links to the Gateway canvas when the channel cannot render them.
 */

export type { CanvasFallbackConfig } from "./create-canvas-fallback-channel.js";
export { createCanvasFallbackChannel } from "./create-canvas-fallback-channel.js";
export type { A2uiBlockInfo } from "./detect-a2ui.js";
export { extractA2uiBlockInfo, isA2uiBlock } from "./detect-a2ui.js";
export type { GatewayClient, GatewayClientConfig, SurfaceResult } from "./gateway-client.js";
export { createGatewayClient } from "./gateway-client.js";
export { generateDegradedText, generateSuccessText } from "./generate-fallback-text.js";
