/**
 * Mock MCP client manager for testing.
 *
 * Provides a fake McpClientManager that can be configured with predefined
 * tools and call results, without requiring a real MCP server.
 */

import type { JsonObject, KoiError, Result } from "@koi/core";
import type { McpClientManager, McpToolInfo } from "../client-manager.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MockMcpServerOptions {
  readonly name: string;
  readonly tools?: readonly McpToolInfo[];
  readonly callResults?: Readonly<Record<string, unknown>>;
  readonly shouldFailConnect?: boolean;
  readonly connectError?: KoiError;
  readonly shouldFailListTools?: boolean;
  readonly listToolsError?: KoiError;
}

export interface MockMcpClientManager extends McpClientManager {
  /** Simulate a tools/list_changed notification from the MCP server. */
  readonly simulateToolsChanged: () => void;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createMockMcpClientManager(options: MockMcpServerOptions): MockMcpClientManager {
  let connected = false;

  const tools: readonly McpToolInfo[] = options.tools ?? [];
  const callResults: Readonly<Record<string, unknown>> = options.callResults ?? {};

  const connect = async (): Promise<Result<void, KoiError>> => {
    if (options.shouldFailConnect === true) {
      return {
        ok: false,
        error: options.connectError ?? {
          code: "EXTERNAL",
          message: `Mock server "${options.name}" connection failed`,
          retryable: false,
          context: { serverName: options.name },
        },
      };
    }
    connected = true;
    return { ok: true, value: undefined };
  };

  const listTools = async (): Promise<Result<readonly McpToolInfo[], KoiError>> => {
    if (options.shouldFailListTools === true) {
      return {
        ok: false,
        error: options.listToolsError ?? {
          code: "EXTERNAL",
          message: `Mock server "${options.name}" list tools failed`,
          retryable: false,
          context: { serverName: options.name },
        },
      };
    }
    return { ok: true, value: tools };
  };

  const callTool = async (name: string, _args: JsonObject): Promise<Result<unknown, KoiError>> => {
    const result = callResults[name];
    if (result === undefined) {
      return {
        ok: false,
        error: {
          code: "NOT_FOUND",
          message: `Mock tool "${name}" not found on server "${options.name}"`,
          retryable: false,
          context: { serverName: options.name, toolName: name },
        },
      };
    }
    return { ok: true, value: result };
  };

  const close = async (): Promise<void> => {
    connected = false;
  };

  // Tool change listener support for testing
  const toolChangeListeners = new Set<() => void>();

  const onToolsChanged = (listener: () => void): (() => void) => {
    toolChangeListeners.add(listener);
    return () => {
      toolChangeListeners.delete(listener);
    };
  };

  const manager: MockMcpClientManager = {
    connect,
    listTools,
    callTool,
    close,
    isConnected: () => connected,
    serverName: () => options.name,
    onToolsChanged,
    simulateToolsChanged: () => {
      for (const listener of toolChangeListeners) {
        listener();
      }
    },
  };

  return manager;
}
