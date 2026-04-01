/**
 * Koi config → Claude Agent SDK Options mapping.
 *
 * Translates ClaudeAdapterConfig fields into the SDK Options shape,
 * with MCP bridge server integration and sdkOverrides applied last.
 */

import type { ClaudeAdapterConfig, SdkCanUseTool } from "./types.js";

/**
 * Minimal SDK Options shape — avoids importing SDK types into adapter API.
 * The real SDK Options type is a superset of this.
 */
export interface SdkOptions {
  readonly model?: string;
  readonly maxTurns?: number;
  readonly maxBudgetUsd?: number;
  readonly cwd?: string;
  readonly systemPrompt?: string;
  readonly permissionMode?: string;
  readonly allowedTools?: readonly string[];
  readonly disallowedTools?: readonly string[];
  readonly includePartialMessages?: boolean;
  readonly mcpServers?: Readonly<Record<string, unknown>>;
  readonly resume?: string;
  readonly abortController?: AbortController;
  readonly canUseTool?: SdkCanUseTool;
  readonly [key: string]: unknown;
}

/**
 * MCP server config for the in-process Koi tool bridge.
 */
export interface McpBridgeConfig {
  readonly type: "sdk";
  readonly name: string;
  readonly instance: unknown;
}

/**
 * Create SDK Options from Koi adapter config.
 *
 * @param config - The Koi adapter configuration
 * @param mcpBridge - Optional MCP bridge server config for Koi tools
 * @param resumeSessionId - Optional session ID for resuming a conversation
 * @param abortController - Optional AbortController for cancellation
 * @param canUseTool - Optional canUseTool callback for HITL approval
 * @returns SDK-compatible options object
 */
export function createSdkOptions(
  config: ClaudeAdapterConfig,
  mcpBridge: McpBridgeConfig | undefined,
  resumeSessionId: string | undefined,
  abortController: AbortController | undefined,
  canUseTool?: SdkCanUseTool,
): SdkOptions {
  return {
    ...(config.model !== undefined ? { model: config.model } : {}),
    ...(config.maxTurns !== undefined ? { maxTurns: config.maxTurns } : {}),
    ...(config.maxBudgetUsd !== undefined ? { maxBudgetUsd: config.maxBudgetUsd } : {}),
    ...(config.cwd !== undefined ? { cwd: config.cwd } : {}),
    ...(config.systemPrompt !== undefined ? { systemPrompt: config.systemPrompt } : {}),
    ...(config.permissionMode !== undefined ? { permissionMode: config.permissionMode } : {}),
    ...(config.allowedTools !== undefined ? { allowedTools: [...config.allowedTools] } : {}),
    ...(config.disallowedTools !== undefined
      ? { disallowedTools: [...config.disallowedTools] }
      : {}),
    // Always enable fine-grained streaming
    includePartialMessages: true,
    // MCP bridge server for Koi tools
    ...(mcpBridge !== undefined ? { mcpServers: { koi_tools: mcpBridge } } : {}),
    // Session resumption
    ...(resumeSessionId !== undefined ? { resume: resumeSessionId } : {}),
    // Abort controller
    ...(abortController !== undefined ? { abortController } : {}),
    // HITL tool approval callback
    ...(canUseTool !== undefined ? { canUseTool } : {}),
    // SDK overrides applied last — can override anything
    ...config.sdkOverrides,
  };
}
