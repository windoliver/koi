/**
 * Claude Agent SDK engine adapter — main factory function.
 *
 * Creates an EngineAdapter that delegates to the Claude Agent SDK's query()
 * function, mapping SDK messages to Koi EngineEvents via streaming passthrough.
 */

import type { EngineEvent, EngineInput, EngineState } from "@koi/core";
import type { SdkMessage } from "./event-map.js";
import { createMessageMapper } from "./event-map.js";
import type { McpBridgeConfig, SdkOptions } from "./policy-map.js";
import { buildSdkOptions } from "./policy-map.js";
import type {
  ClaudeAdapterConfig,
  ClaudeEngineAdapter,
  ClaudeQueryControls,
  ClaudeSessionState,
} from "./types.js";

const ENGINE_ID = "claude" as const;

// ---------------------------------------------------------------------------
// SDK function types — thin wrappers to avoid leaking SDK types
// ---------------------------------------------------------------------------

/**
 * SDK query result — extends AsyncIterable with optional control methods
 * that proxy the real SDK Query object.
 *
 * All control methods are optional so callers returning a bare
 * AsyncIterable still satisfy this interface.
 */
export interface SdkQuery extends AsyncIterable<SdkMessage> {
  readonly interrupt?: () => Promise<void>;
  readonly setModel?: (model?: string) => Promise<void>;
  readonly setPermissionMode?: (mode: string) => Promise<void>;
  readonly stopTask?: (taskId: string) => Promise<void>;
  readonly close?: () => void;
}

/**
 * SDK query function shape. Accepts prompt + options, returns an SdkQuery
 * (AsyncIterable with optional control methods).
 */
export type SdkQueryFn = (params: {
  readonly prompt: string;
  readonly options?: SdkOptions;
}) => SdkQuery;

/**
 * Optional SDK functions for MCP bridge creation.
 */
export interface SdkFunctions {
  readonly query: SdkQueryFn;
  readonly createSdkMcpServer?: (config: {
    readonly name: string;
    readonly version: string;
    readonly tools: readonly unknown[];
  }) => unknown;
  readonly tool?: (
    name: string,
    description: string,
    schema: unknown,
    handler: (args: Readonly<Record<string, unknown>>) => Promise<unknown>,
  ) => unknown;
}

// ---------------------------------------------------------------------------
// Input → prompt conversion
// ---------------------------------------------------------------------------

/**
 * Extract a text prompt from EngineInput.
 */
function inputToPrompt(input: EngineInput): string {
  switch (input.kind) {
    case "text":
      return input.text;
    case "messages": {
      // Concatenate all text content blocks from the messages
      const parts: string[] = [];
      for (const msg of input.messages) {
        for (const block of msg.content) {
          if (block.kind === "text") {
            parts.push(block.text);
          }
        }
      }
      return parts.join("\n");
    }
    case "resume":
      // Resume input — prompt is empty; session ID drives the continuation
      return "";
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a Claude Agent SDK engine adapter.
 *
 * @param config - Adapter configuration (Koi-native)
 * @param sdk - SDK function bindings (query, createSdkMcpServer, tool)
 * @param mcpBridge - Optional pre-built MCP bridge for Koi tools
 * @returns EngineAdapter implementation
 */
export function createClaudeAdapter(
  config: ClaudeAdapterConfig,
  sdk: SdkFunctions,
  mcpBridge?: McpBridgeConfig,
): ClaudeEngineAdapter {
  // let: toggled by dispose() — lifecycle flag
  let disposed = false;
  // let: guards against concurrent runs
  let running = false;
  // let: tracks active AbortController for cancellation
  let activeAbortController: AbortController | undefined;
  // let: tracks active SDK query for control method delegation
  let activeQuery: SdkQuery | undefined;
  // Session state for resume support
  const sessionState: { sessionId: string | undefined } = { sessionId: undefined };

  async function* runStream(input: EngineInput): AsyncGenerator<EngineEvent, void, undefined> {
    if (running) {
      throw new Error(
        "ClaudeAdapter does not support concurrent runs. Wait for the current run to complete.",
      );
    }
    if (disposed) {
      yield {
        kind: "done",
        output: {
          content: [],
          stopReason: "interrupted",
          metrics: { totalTokens: 0, inputTokens: 0, outputTokens: 0, turns: 0, durationMs: 0 },
        },
      };
      return;
    }

    running = true;
    const abortController = new AbortController();
    activeAbortController = abortController;

    // Fresh message mapper per run — holds StreamEventMapper state
    const mapper = createMessageMapper();

    try {
      const prompt = inputToPrompt(input);

      // Determine resume session ID
      const resumeSessionId =
        input.kind === "resume"
          ? (extractSessionIdFromState(input.state) ?? sessionState.sessionId)
          : undefined;

      const options = buildSdkOptions(config, mcpBridge, resumeSessionId, abortController);

      const queryIterable = sdk.query({ prompt, options });
      activeQuery = queryIterable;
      let receivedDone = false;

      // Turn boundary tracking: a turn ends when a user message (tool results)
      // follows an assistant message, signaling the assistant's tool calls completed.
      let turnIndex = 0;
      let sawAssistant = false;

      for await (const message of queryIterable) {
        if (abortController.signal.aborted) break;

        // Detect turn boundary before mapping: user after assistant = turn end
        const msgType = (message as { readonly type: string }).type;
        if (msgType === "user" && sawAssistant) {
          yield { kind: "turn_end", turnIndex };
          turnIndex += 1;
          sawAssistant = false;
        }
        if (msgType === "assistant") {
          sawAssistant = true;
        }

        const result = mapper.map(message);

        // Capture session ID from init or result messages
        if (result.sessionId !== undefined) {
          sessionState.sessionId = result.sessionId;
        }

        for (const event of result.events) {
          yield event;
        }

        if (result.isDone) {
          receivedDone = true;
        }
      }

      // Synthetic done event if SDK yielded no result
      if (!receivedDone) {
        yield {
          kind: "done",
          output: {
            content: [],
            stopReason: abortController.signal.aborted ? "interrupted" : "error",
            metrics: {
              totalTokens: 0,
              inputTokens: 0,
              outputTokens: 0,
              turns: 0,
              durationMs: 0,
            },
          },
        };
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      yield {
        kind: "done",
        output: {
          content: [{ kind: "text", text: `Error: ${message}` }],
          stopReason: "error",
          metrics: {
            totalTokens: 0,
            inputTokens: 0,
            outputTokens: 0,
            turns: 0,
            durationMs: 0,
          },
          metadata: {
            error: message,
            ...(error instanceof Error && error.cause !== undefined
              ? { cause: String(error.cause) }
              : {}),
          },
        },
      };
    } finally {
      activeQuery = undefined;
      running = false;
      activeAbortController = undefined;
    }
  }

  // Controls proxy — delegates to activeQuery's methods when available
  const controls: ClaudeQueryControls = {
    interrupt: async (): Promise<void> => {
      await activeQuery?.interrupt?.();
    },
    setModel: async (model?: string): Promise<void> => {
      await activeQuery?.setModel?.(model);
    },
    setPermissionMode: async (mode: string): Promise<void> => {
      await activeQuery?.setPermissionMode?.(mode);
    },
    stopTask: async (taskId: string): Promise<void> => {
      await activeQuery?.stopTask?.(taskId);
    },
  };

  const adapter: ClaudeEngineAdapter = {
    engineId: ENGINE_ID,

    // Non-cooperating adapter — no terminals
    // The SDK manages its own model/tool calls internally

    stream: (input: EngineInput): AsyncIterable<EngineEvent> => {
      return runStream(input);
    },

    get controls(): ClaudeQueryControls | undefined {
      return running ? controls : undefined;
    },

    saveState: async (): Promise<EngineState> => {
      const data: ClaudeSessionState = { sessionId: sessionState.sessionId };
      return { engineId: ENGINE_ID, data };
    },

    loadState: async (state: EngineState): Promise<void> => {
      if (state.engineId !== ENGINE_ID) {
        throw new Error(`Cannot load state from engine "${state.engineId}" into "${ENGINE_ID}"`);
      }
      const data = state.data as ClaudeSessionState | undefined;
      if (data?.sessionId !== undefined) {
        sessionState.sessionId = data.sessionId;
      }
    },

    dispose: async (): Promise<void> => {
      disposed = true;
      if (activeAbortController !== undefined) {
        activeAbortController.abort();
      }
    },
  };

  return adapter;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractSessionIdFromState(state: EngineState): string | undefined {
  if (typeof state.data !== "object" || state.data === null) return undefined;
  const record = state.data as Record<string, unknown>;
  if (typeof record.sessionId === "string") return record.sessionId;
  return undefined;
}
