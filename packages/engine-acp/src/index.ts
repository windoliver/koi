/**
 * @koi/engine-acp — ACP (Agent Client Protocol) engine adapter (Layer 2).
 *
 * A headless ACP client that orchestrates ACP-compatible coding agents
 * (Claude Code, Gemini CLI, Codex CLI, etc.) as Koi engine backends.
 *
 * Implements the EngineAdapter contract from @koi/core via JSON-RPC 2.0
 * over stdin/stdout, with capability negotiation, typed content blocks,
 * session management, and routing of fs/*, terminal/*, and
 * request_permission callbacks.
 */

export type { AgentCapabilities, ClientCapabilities } from "./acp-schema.js";
export { createAcpAdapter } from "./adapter.js";
export type { ApprovalBridgeResult } from "./approval-bridge.js";
export { resolvePermission } from "./approval-bridge.js";
export { descriptor } from "./descriptor.js";
export { mapSessionUpdate } from "./event-map.js";
export type { AcpProcess, AcpTransport } from "./transport.js";
export { createStdioTransport } from "./transport.js";
export type { AcpAdapterConfig, AcpEngineAdapter } from "./types.js";
