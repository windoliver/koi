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

// Re-export shared protocol types for backward compatibility
export type { AcpTransport, AgentCapabilities, ClientCapabilities } from "@koi/acp-protocol";
export { mapSessionUpdate } from "@koi/acp-protocol";

export { createAcpAdapter } from "./adapter.js";
export type { ApprovalBridgeResult } from "./approval-bridge.js";
export { resolvePermission } from "./approval-bridge.js";
export { descriptor } from "./descriptor.js";
export type { AcpProcess } from "./transport.js";
export { createStdioTransport } from "./transport.js";
export type { AcpAdapterConfig, AcpEngineAdapter } from "./types.js";
