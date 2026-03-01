/**
 * @koi/acp — ACP server ChannelAdapter for IDE integration (Layer 2).
 *
 * Makes Koi agents consumable by IDEs (JetBrains, Zed, VS Code) via the
 * Agent Client Protocol (ACP v0.10.x, JSON-RPC 2.0 over stdin/stdout).
 *
 * Usage: an IDE spawns `koi serve --manifest koi.yaml` and communicates
 * with the agent exactly like Claude Code or Gemini CLI.
 */

export { createAcpChannel } from "./acp-channel.js";
export { createApprovalHandler } from "./approval-bridge.js";
export { descriptor } from "./descriptor.js";
export type { ProtocolHandler, ProtocolState } from "./protocol-handler.js";
export { createProtocolHandler } from "./protocol-handler.js";
export type { RequestTracker } from "./request-tracker.js";
export { createRequestTracker } from "./request-tracker.js";
export { createProcessTransport } from "./server-transport.js";
export type { AcpChannelAdapter, AcpServerConfig } from "./types.js";
export { ACP_PROTOCOL_VERSION, DEFAULT_BACKPRESSURE_LIMIT, DEFAULT_TIMEOUTS } from "./types.js";
