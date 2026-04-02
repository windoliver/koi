/**
 * Mock McpConnection for unit tests.
 *
 * Provides mutable tool lists and configurable call results
 * so tests can simulate dynamic tool changes, failures, etc.
 */

import type { JsonObject, KoiError, Result } from "@koi/core";
import type { McpConnection, McpToolInfo } from "../connection.js";
import type { TransportState } from "../state.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MockConnectionOptions {
  readonly name: string;
  readonly tools?: readonly McpToolInfo[];
  readonly callResults?: Readonly<Record<string, Result<unknown, KoiError>>>;
  readonly shouldFailConnect?: boolean;
  readonly shouldFailListTools?: boolean;
  readonly initialState?: TransportState;
}

export interface MockConnection extends McpConnection {
  /** Replace the tool list (simulates server-side tool changes). */
  readonly setTools: (tools: readonly McpToolInfo[]) => void;
  /** Manually fire the tool-change notification to listeners. */
  readonly simulateToolsChanged: () => void;
  /** Track how many times listTools was called (for cache tests). */
  readonly listToolsCallCount: () => number;
  /** Track how many times connect was called. */
  readonly connectCallCount: () => number;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createMockConnection(
  name: string,
  tools: readonly McpToolInfo[] = [],
  callResults: Readonly<Record<string, Result<unknown, KoiError>>> = {},
  options?: {
    readonly shouldFailConnect?: boolean;
    readonly shouldFailListTools?: boolean;
    readonly initialState?: TransportState;
    /** Delay connect() by this many ms (simulates slow/hung server). */
    readonly connectDelayMs?: number;
  },
): MockConnection {
  let currentTools = [...tools]; // let justified: mutable for test simulation
  let connectCount = 0; // let justified: test tracking counter
  let listToolsCount = 0; // let justified: test tracking counter
  let currentState: TransportState = options?.initialState ?? { kind: "idle" }; // let justified: state tracking
  const toolChangeListeners = new Set<() => void>();
  const stateChangeListeners = new Set<(state: TransportState) => void>();

  const connect = async (): Promise<Result<void, KoiError>> => {
    connectCount++;
    if (options?.connectDelayMs !== undefined) {
      await new Promise((resolve) => setTimeout(resolve, options.connectDelayMs));
    }
    if (options?.shouldFailConnect === true) {
      currentState = {
        kind: "error",
        error: { code: "EXTERNAL", message: `Mock connect failed: ${name}`, retryable: false },
        retryable: false,
      };
      return {
        ok: false,
        error: { code: "EXTERNAL", message: `Mock connect failed: ${name}`, retryable: false },
      };
    }
    currentState = { kind: "connected" };
    for (const listener of stateChangeListeners) {
      listener(currentState);
    }
    return { ok: true, value: undefined };
  };

  const listTools = async (): Promise<Result<readonly McpToolInfo[], KoiError>> => {
    listToolsCount++;
    if (options?.shouldFailListTools === true) {
      return {
        ok: false,
        error: { code: "EXTERNAL", message: `Mock listTools failed: ${name}`, retryable: false },
      };
    }
    return { ok: true, value: currentTools };
  };

  const callTool = async (_name: string, _args: JsonObject): Promise<Result<unknown, KoiError>> => {
    const result = callResults[_name];
    if (result === undefined) {
      return {
        ok: false,
        error: {
          code: "NOT_FOUND",
          message: `No mock result for tool: ${_name}`,
          retryable: false,
        },
      };
    }
    return result;
  };

  const close = async (): Promise<void> => {
    currentState = { kind: "closed" };
  };

  return {
    connect,
    listTools,
    callTool,
    close,
    get state() {
      return currentState;
    },
    serverName: name,
    onStateChange: (listener) => {
      stateChangeListeners.add(listener);
      return () => {
        stateChangeListeners.delete(listener);
      };
    },
    onToolsChanged: (listener) => {
      toolChangeListeners.add(listener);
      return () => {
        toolChangeListeners.delete(listener);
      };
    },
    setTools: (newTools) => {
      currentTools = [...newTools];
    },
    simulateToolsChanged: () => {
      for (const listener of toolChangeListeners) {
        listener();
      }
    },
    listToolsCallCount: () => listToolsCount,
    connectCallCount: () => connectCount,
  };
}
