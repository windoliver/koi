/**
 * @koi/agui — AG-UI SSE channel adapter for Koi agents.
 *
 * Connects CopilotKit-compatible web frontends to Koi agents via the
 * AG-UI open protocol (HTTP + Server-Sent Events).
 *
 * Quick start:
 * ```typescript
 * import { createAguiChannel } from "@koi/agui";
 *
 * const { channel, middleware } = createAguiChannel({ port: 3000 });
 * // Register channel and middleware in your Koi agent manifest.
 * ```
 *
 * For embedding into an existing server:
 * ```typescript
 * import { createAguiHandler } from "@koi/agui";
 *
 * const { handler, middleware } = createAguiHandler({ path: "/api/agent" });
 * Bun.serve({ fetch: async (req) => (await handler(req)) ?? fallback(req) });
 * ```
 */

export type { AguiChannelConfig, AguiChannelResult, AguiHandlerResult } from "./agui-channel.js";
export {
  captureAguiEvents,
  createAguiChannel,
  createAguiHandler,
  handleAguiRequest,
} from "./agui-channel.js";

export type { AguiStreamMiddlewareConfig } from "./agui-middleware.js";
export { createAguiStreamMiddleware } from "./agui-middleware.js";
export { mapBlocksToAguiEvents } from "./event-map.js";
export type { NormalizationMode } from "./normalize.js";
export { extractMessageText, normalizeRunAgentInput } from "./normalize.js";
export type { RunContextStore, SseWriter } from "./run-context-store.js";
export { createRunContextStore } from "./run-context-store.js";
