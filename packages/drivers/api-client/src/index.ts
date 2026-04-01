/**
 * @koi/api-client — Anthropic SDK adapter for Koi.
 *
 * Provides ModelHandler and ModelStreamHandler implementations
 * via the @anthropic-ai/sdk package.
 */

export type { AnthropicClient } from "./client.js";
// Factory
export { createAnthropicClient } from "./client.js";

// Config
export type { AnthropicClientConfig, AnthropicProvider } from "./config.js";
export { DEFAULT_MAX_TOKENS, DEFAULT_MODEL, DEFAULT_TIMEOUT_MS } from "./config.js";
export { mapAnthropicError, mapStatusToKoiCode } from "./map-error.js";
// Pure mappers (reusable by model-router or tests)
export { toAnthropicParams, toAnthropicStreamParams } from "./map-request.js";
export { fromAnthropicMessage } from "./map-response.js";
export { mapAnthropicStream } from "./map-stream.js";
export { toAnthropicTools } from "./map-tools.js";
export { extractSystemAndMessages, mapSenderIdToRole, toAnthropicContent } from "./normalize.js";
