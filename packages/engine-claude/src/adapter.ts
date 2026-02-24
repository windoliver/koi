/**
 * Claude Agent SDK engine adapter — main factory function.
 *
 * Creates an EngineAdapter that delegates to the Claude Agent SDK's query()
 * function, mapping SDK messages to Koi EngineEvents via streaming passthrough.
 *
 * Uses V1 Streaming Input mode: the prompt is always an AsyncIterable<SdkInputMessage>,
 * enabling human-in-the-loop message injection via saveHumanMessage().
 */

import type {
  EngineEvent,
  EngineInput,
  EngineOutput,
  EngineState,
  EngineStopReason,
} from "@koi/core";
import type { HitlEventEmitter } from "./approval-bridge.js";
import { createApprovalBridge } from "./approval-bridge.js";
import type { SdkMessage } from "./event-map.js";
import { createMessageMapper } from "./event-map.js";
import type { MessageQueue } from "./message-queue.js";
import { createMessageQueue } from "./message-queue.js";
import type { McpBridgeConfig, SdkOptions } from "./policy-map.js";
import { createSdkOptions } from "./policy-map.js";
import type {
  ClaudeAdapterConfig,
  ClaudeEngineAdapter,
  ClaudeQueryControls,
  ClaudeSessionState,
  SdkCanUseTool,
} from "./types.js";

const ENGINE_ID = "claude" as const;

// ---------------------------------------------------------------------------
// SDK function types — thin wrappers to avoid leaking SDK types
// ---------------------------------------------------------------------------

/**
 * Message shape for streaming input to the Claude SDK (V1 Streaming Input).
 * This is what we SEND to the SDK as prompt items.
 */
export interface SdkInputMessage {
  readonly type: "user";
  readonly message: {
    readonly role: "user";
    readonly content: string;
  };
}

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
 * SDK query function shape. Accepts prompt (string or streaming input) + options,
 * returns an SdkQuery (AsyncIterable with optional control methods).
 */
export type SdkQueryFn = (params: {
  readonly prompt: string | AsyncIterable<SdkInputMessage>;
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
// Input → SdkInputMessage conversion
// ---------------------------------------------------------------------------

/**
 * Convert EngineInput to an SdkInputMessage for the streaming input queue.
 */
function inputToSdkInputMessage(input: EngineInput): SdkInputMessage | undefined {
  switch (input.kind) {
    case "text":
      return {
        type: "user",
        message: { role: "user", content: input.text },
      };
    case "messages": {
      const parts: string[] = [];
      for (const msg of input.messages) {
        for (const block of msg.content) {
          if (block.kind === "text") {
            parts.push(block.text);
          }
        }
      }
      const text = parts.join("\n");
      if (text.length === 0) return undefined;
      return {
        type: "user",
        message: { role: "user", content: text },
      };
    }
    case "resume":
      return undefined;
  }
}

// ---------------------------------------------------------------------------
// Done event helpers — extracted to reduce runStream size
// ---------------------------------------------------------------------------

const ZERO_METRICS = {
  totalTokens: 0,
  inputTokens: 0,
  outputTokens: 0,
  turns: 0,
  durationMs: 0,
} as const;

function createDoneEvent(
  stopReason: EngineStopReason,
  errorMessage?: string,
): EngineEvent & { readonly kind: "done" } {
  const output: EngineOutput =
    errorMessage !== undefined
      ? {
          content: [{ kind: "text", text: `Error: ${errorMessage}` }],
          stopReason,
          metrics: ZERO_METRICS,
        }
      : { content: [], stopReason, metrics: ZERO_METRICS };
  return { kind: "done", output };
}

function createErrorDoneEvent(error: unknown): EngineEvent & { readonly kind: "done" } {
  const message = error instanceof Error ? error.message : String(error);
  return {
    kind: "done",
    output: {
      content: [{ kind: "text", text: `Error: ${message}` }],
      stopReason: "error",
      metrics: ZERO_METRICS,
      metadata: {
        error: message,
        ...(error instanceof Error && error.cause !== undefined
          ? { cause: String(error.cause) }
          : {}),
      },
    },
  };
}

/**
 * Drain pending messages into the queue, then push the initial input message.
 * Returns true if at least one message was pushed, false otherwise.
 */
function seedQueue(
  pendingMessages: SdkInputMessage[],
  queue: MessageQueue<SdkInputMessage>,
  input: EngineInput,
): boolean {
  let seeded = false;
  while (pendingMessages.length > 0) {
    // biome-ignore lint/style/noNonNullAssertion: length > 0 guarantees element
    queue.push(pendingMessages.shift()!);
    seeded = true;
  }
  const initialMessage = inputToSdkInputMessage(input);
  if (initialMessage !== undefined) {
    queue.push(initialMessage);
    seeded = true;
  }
  return seeded;
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
 * @returns EngineAdapter implementation with HITL support
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
  // let: tracks active message queue for HITL message injection
  let activeQueue: MessageQueue<SdkInputMessage> | undefined;
  // let: session state updated on init/result messages and loadState()
  let sessionState: ClaudeSessionState = { sessionId: undefined };
  // Mutable buffer: internal queue with single-owner lifecycle, never exposed
  // outside createClaudeAdapter. Immutable rebuild per-drain would add O(n)
  // copies per message with no safety benefit.
  const pendingMessages: SdkInputMessage[] = [];

  // Build canUseTool bridge if approval handler is configured
  // let: holds the custom event emitter callback set during stream()
  let hitlEventCallback:
    | ((event: { readonly type: string; readonly data: unknown }) => void)
    | undefined;

  const hitlEmitter: HitlEventEmitter | undefined =
    config.approvalHandler !== undefined
      ? { emit: (event) => hitlEventCallback?.(event) }
      : undefined;

  const canUseTool: SdkCanUseTool | undefined =
    config.approvalHandler !== undefined
      ? createApprovalBridge(config.approvalHandler, hitlEmitter)
      : undefined;

  async function* runStream(input: EngineInput): AsyncGenerator<EngineEvent, void, undefined> {
    if (running) {
      throw new Error(
        "ClaudeAdapter does not support concurrent runs. Wait for the current run to complete.",
      );
    }
    if (disposed) {
      yield createDoneEvent("interrupted");
      return;
    }

    running = true;
    const abortController = new AbortController();
    activeAbortController = abortController;

    // Compose caller signal with internal controller for unified cancellation
    if (input.signal !== undefined) {
      if (input.signal.aborted) {
        abortController.abort(input.signal.reason);
      } else {
        input.signal.addEventListener("abort", () => abortController.abort(input.signal?.reason), {
          once: true,
        });
      }
    }

    const queue = createMessageQueue<SdkInputMessage>(
      config.hitl?.maxQueueSize !== undefined ? { maxSize: config.hitl.maxQueueSize } : undefined,
    );
    activeQueue = queue;

    // Mutable buffer: accumulates HITL bridge events between SDK message yields.
    // Single-owner within this generator scope, drained inline.
    const pendingHitlEvents: EngineEvent[] = [];
    hitlEventCallback = (event) => {
      pendingHitlEvents.push({ kind: "custom", type: event.type, data: event.data });
    };

    const mapper = createMessageMapper();

    try {
      const hasInput = seedQueue(pendingMessages, queue, input);

      // When no messages were seeded (e.g. resume with no pending messages),
      // close the queue so the SDK subprocess knows there is no input coming
      // and can exit after producing its output.
      if (!hasInput) {
        queue.close();
      }

      const resumeSessionId =
        input.kind === "resume"
          ? (extractSessionIdFromState(input.state) ?? sessionState.sessionId)
          : undefined;

      const options = createSdkOptions(
        config,
        mcpBridge,
        resumeSessionId,
        abortController,
        canUseTool,
      );
      const queryIterable = sdk.query({ prompt: queue, options });
      activeQuery = queryIterable;
      let receivedDone = false;

      // Turn boundary tracking
      let turnIndex = 0;
      let sawAssistant = false;

      for await (const message of queryIterable) {
        if (abortController.signal.aborted) break;

        // Drain HITL events accumulated during canUseTool calls
        while (pendingHitlEvents.length > 0) {
          // biome-ignore lint/style/noNonNullAssertion: length > 0 guarantees element
          yield pendingHitlEvents.shift()!;
        }

        // Detect turn boundary: user after assistant = turn end
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

        if (result.sessionId !== undefined) {
          sessionState = { sessionId: result.sessionId };
        }

        for (const event of result.events) {
          yield event;
        }

        if (result.isDone) {
          receivedDone = true;
          // Close the queue so the SDK subprocess can exit and its iterator
          // completes. Without this the SDK process stays alive waiting for
          // more streaming input, causing the for-await loop to hang.
          queue.close();
        }
      }

      // Drain remaining HITL events
      while (pendingHitlEvents.length > 0) {
        // biome-ignore lint/style/noNonNullAssertion: length > 0 guarantees element
        yield pendingHitlEvents.shift()!;
      }

      if (!receivedDone) {
        yield createDoneEvent(abortController.signal.aborted ? "interrupted" : "error");
      }
    } catch (error: unknown) {
      yield createErrorDoneEvent(error);
    } finally {
      queue.close();
      activeQueue = undefined;
      activeQuery = undefined;
      running = false;
      activeAbortController = undefined;
      hitlEventCallback = undefined;
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

    stream: (input: EngineInput): AsyncIterable<EngineEvent> => {
      return runStream(input);
    },

    get controls(): ClaudeQueryControls | undefined {
      return running ? controls : undefined;
    },

    saveHumanMessage(text: string): void {
      if (disposed) {
        console.warn("ClaudeAdapter: saveHumanMessage() called after dispose() — message dropped");
        return;
      }

      const message: SdkInputMessage = {
        type: "user",
        message: { role: "user", content: text },
      };

      if (activeQueue !== undefined) {
        activeQueue.push(message);
      } else {
        pendingMessages.push(message);
      }
    },

    saveState: async (): Promise<EngineState> => {
      return { engineId: ENGINE_ID, data: sessionState };
    },

    loadState: async (state: EngineState): Promise<void> => {
      if (state.engineId !== ENGINE_ID) {
        throw new Error(`Cannot load state from engine "${state.engineId}" into "${ENGINE_ID}"`);
      }
      const data = state.data as ClaudeSessionState | undefined;
      if (data?.sessionId !== undefined) {
        sessionState = { sessionId: data.sessionId };
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
