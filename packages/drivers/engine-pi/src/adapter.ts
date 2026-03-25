/**
 * createPiAdapter — factory that assembles the pi-agent-core engine adapter.
 *
 * Orchestrates: config parsing → model resolution → terminal creation →
 * per-call pi Agent construction → event bridging.
 */

import type { ToolDescriptor } from "@koi/core/ecs";
import type { EngineEvent, EngineInput } from "@koi/core/engine";
import type { AgentMessage, AgentOptions, StreamFn } from "@mariozechner/pi-agent-core";
import { Agent as PiAgent } from "@mariozechner/pi-agent-core";
import type { Api, Message, Model, UserMessage } from "@mariozechner/pi-ai";
import {
  completeSimple,
  createAssistantMessageEventStream,
  getModel,
  streamSimple,
} from "@mariozechner/pi-ai";
import { AsyncQueue, createEventSubscriber } from "./event-bridge.js";
import { engineInputToHistory, engineInputToPrompt, PI_CAPABILITIES } from "./message-map.js";
import { createMetricsAccumulator } from "./metrics.js";
import { createModelCallTerminal, createModelStreamTerminal } from "./model-terminal.js";
import { createBridgeStreamFn } from "./stream-bridge.js";
import { wrapTool } from "./tool-bridge.js";
import type { PiAdapterConfig, PiEngineAdapter } from "./types.js";

/**
 * Non-streaming wrapper for providers whose SSE streaming doesn't handle tool calls
 * (e.g. OpenRouter). Uses pi-ai's generateSimple (non-streaming) and emits
 * synthetic AssistantMessageEvents from the complete response.
 */
function createNonStreamingWrapper(_piModel: Model<Api>): StreamFn {
  return (model, context, options) => {
    const stream = createAssistantMessageEventStream();
    void (async () => {
      try {
        const message = await completeSimple(model, context, options);
        stream.push({ type: "start", partial: message });
        // Emit text content
        for (const block of message.content) {
          if (block.type === "text") {
            stream.push({
              type: "text_delta",
              contentIndex: 0,
              delta: block.text,
              partial: message,
            });
          }
        }
        // Emit tool calls
        for (let i = 0; i < message.content.length; i++) {
          const block = message.content[i];
          if (block !== undefined && block.type === "toolCall") {
            stream.push({ type: "toolcall_start", contentIndex: i, partial: message });
            stream.push({
              type: "toolcall_delta",
              contentIndex: i,
              delta: JSON.stringify(block.arguments),
              partial: message,
            });
            stream.push({
              type: "toolcall_end",
              contentIndex: i,
              toolCall: block,
              partial: message,
            } as unknown as Parameters<typeof stream.push>[0]);
          }
        }
        stream.push({ type: "done", reason: "stop", message });
        stream.end(message);
      } catch (error: unknown) {
        const errMessage = {
          role: "assistant" as const,
          content: [],
          api: model.api,
          provider: model.provider,
          model: model.id,
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "error" as const,
          errorMessage: error instanceof Error ? error.message : String(error),
          timestamp: Date.now(),
        };
        stream.push({ type: "error", reason: "error", error: errMessage } as unknown as Parameters<
          typeof stream.push
        >[0]);
        stream.end(errMessage as unknown as Parameters<typeof stream.end>[0]);
      }
    })();
    return stream;
  };
}

/**
 * Parse a "provider:model-id" string into provider and model components.
 */
function parseModelString(model: string): { readonly provider: string; readonly modelId: string } {
  const colonIndex = model.indexOf(":");
  if (colonIndex === -1) {
    throw new Error(
      `Invalid model string "${model}": expected "provider:model-id" format (e.g., "anthropic:claude-sonnet-4-5-20250929")`,
    );
  }
  return {
    provider: model.slice(0, colonIndex),
    modelId: model.slice(colonIndex + 1),
  };
}

/**
 * Check if a value is a pi Message with a role property.
 */
function isMessage(value: unknown): value is Message {
  return typeof value === "object" && value !== null && "role" in value;
}

/**
 * Default convertToLlm function for pi Agent.
 * Filters to standard LLM message roles (user, assistant, toolResult).
 */
function defaultConvertToLlm(messages: readonly AgentMessage[]): AgentMessage[] {
  return messages.filter((m): m is Message => {
    if (!isMessage(m)) return false;
    return m.role === "user" || m.role === "assistant" || m.role === "toolResult";
  });
}

/**
 * Create a PiEngineAdapter wrapping @mariozechner/pi-agent-core.
 *
 * Creates a fresh pi Agent per stream() call to capture callHandlers
 * without mutable shared state. steer/followUp/abort delegate to the
 * current active agent instance.
 */
export function createPiAdapter(config: PiAdapterConfig): PiEngineAdapter {
  const { provider, modelId } = parseModelString(config.model);

  // getModel uses overloaded signatures for known providers.
  // We pass the raw strings — pi-ai validates provider/model at runtime
  // and throws if the combination is invalid.
  const piModel = getModel(
    provider as Parameters<typeof getModel>[0],
    modelId as Parameters<typeof getModel>[1],
  );

  // Create model terminals
  const modelStreamTerminal = createModelStreamTerminal();
  const modelCallTerminal = createModelCallTerminal(modelStreamTerminal);

  // The real streamSimple function (called by the model terminal).
  // For OpenRouter, pi-ai's SSE streaming doesn't handle tool_calls in the
  // delta, causing tool-use responses to silently fail. Use a non-streaming
  // wrapper that calls the API without streaming and emits synthetic events.
  const realStreamSimple: StreamFn =
    provider === "openrouter"
      ? createNonStreamingWrapper(piModel)
      : (model, context, options) => streamSimple(model, context, options);

  // Track the current active pi Agent for steer/followUp/abort
  // let justified: mutable ref needed for lifecycle delegation across stream() calls
  let currentPiAgent: PiAgent | undefined;

  return {
    engineId: "pi-agent-core",
    capabilities: PI_CAPABILITIES,

    terminals: {
      modelCall: modelCallTerminal,
      modelStream: modelStreamTerminal,
    },

    stream(input: EngineInput): AsyncIterable<EngineEvent> {
      const queue = new AsyncQueue<EngineEvent>();
      const metrics = createMetricsAccumulator();

      const callHandlers = input.callHandlers;
      if (!callHandlers) {
        throw new Error(
          "PiEngineAdapter requires callHandlers (cooperating mode). " +
            "Ensure the adapter is used with createKoi() which provides middleware-composed handlers.",
        );
      }

      // Build the bridge streamFn that routes through middleware
      const modelStream = callHandlers.modelStream;
      if (!modelStream) {
        throw new Error(
          "PiEngineAdapter requires callHandlers.modelStream. " +
            "This should be provided by L1 when terminals.modelStream is defined.",
        );
      }
      const bridgeStreamFn = createBridgeStreamFn(modelStream, realStreamSimple);

      // Wrap Koi tool descriptors as pi AgentTools, routing execution through middleware.
      // Build a reverse map from sanitized API names → original Koi names for event bridging.
      const toolNameMap = new Map<string, string>();
      const agentTools =
        input.kind === "resume"
          ? []
          : callHandlers.tools.map((desc: ToolDescriptor) => {
              const tool = wrapTool(desc, callHandlers.toolCall);
              const existing = toolNameMap.get(tool.name);
              if (existing !== undefined) {
                throw new Error(
                  `Tool name collision: "${desc.name}" sanitizes to "${tool.name}" ` +
                    `which is already used by "${existing}".`,
                );
              }
              if (tool.name !== desc.name) {
                toolNameMap.set(tool.name, desc.name);
              }
              return tool;
            });

      const subscriber = createEventSubscriber(queue, metrics, toolNameMap);

      // Seed pi Agent with conversation history from the EngineInput.
      // For "messages" inputs, this preserves prior user/assistant/tool-result
      // messages so the model sees full context — not just the latest prompt string.
      const historyMessages = engineInputToHistory(input);

      // Build pi Agent options immutably with conditional spread.
      // Captures transformContext in a local const to satisfy TypeScript narrowing in closures.
      const transformContext = config.transformContext;
      const piAgentOptions: AgentOptions = {
        initialState: {
          systemPrompt: config.systemPrompt ?? "",
          model: piModel,
          thinkingLevel:
            config.thinkingLevel === "off" ? "minimal" : (config.thinkingLevel ?? "minimal"),
          tools: [...agentTools],
          messages: [...historyMessages],
          isStreaming: false,
          streamMessage: null,
          pendingToolCalls: new Set(),
        },
        streamFn: bridgeStreamFn,
        convertToLlm: defaultConvertToLlm,
        steeringMode: config.steeringMode ?? "all",
        ...(transformContext
          ? {
              transformContext: async (
                messages: AgentMessage[],
                signal?: AbortSignal,
              ): Promise<AgentMessage[]> => {
                // Convert vendor AgentMessage[] → ContextMessage[] for the public API
                const contextMessages = messages.map((m) => ({
                  role:
                    typeof m === "object" && m !== null && "role" in m ? String(m.role) : "unknown",
                  content: typeof m === "object" && m !== null && "content" in m ? m.content : m,
                  ...(typeof m === "object" && m !== null && "timestamp" in m
                    ? { timestamp: m.timestamp as number }
                    : {}),
                }));
                const result = await transformContext(contextMessages, signal);
                // The transform returns the same structural shape — cast back
                return result as unknown as AgentMessage[];
              },
            }
          : {}),
        ...(config.getApiKey ? { getApiKey: config.getApiKey } : {}),
      };

      // Create a fresh pi Agent for this stream() call
      const piAgent = new PiAgent(piAgentOptions);

      // Store as current agent for steer/followUp/abort
      currentPiAgent = piAgent;

      // Wire caller signal → piAgent.abort() for cancellation propagation
      if (input.signal !== undefined) {
        if (input.signal.aborted) {
          piAgent.abort();
        } else {
          input.signal.addEventListener("abort", () => piAgent.abort(), { once: true });
        }
      }

      // Subscribe to pi Agent events
      const unsubscribe = piAgent.subscribe(subscriber);

      // Start the agent loop
      const prompt = engineInputToPrompt(input);
      void piAgent.prompt(prompt).catch((error: unknown) => {
        // If the agent loop fails, push an error event
        const finalMetrics = metrics.finalize();
        queue.push({
          kind: "done",
          output: {
            content: [],
            stopReason: "error",
            metrics: finalMetrics,
            metadata: {
              error: error instanceof Error ? error.message : String(error),
            },
          },
        });
        queue.end();
      });

      // Return an iterable that cleans up on completion
      return {
        [Symbol.asyncIterator](): AsyncIterator<EngineEvent> {
          const inner = queue[Symbol.asyncIterator]();
          return {
            async next(): Promise<IteratorResult<EngineEvent>> {
              const result = await inner.next();
              if (result.done) {
                unsubscribe();
                if (currentPiAgent === piAgent) {
                  currentPiAgent = undefined;
                }
              }
              return result;
            },
            async return(): Promise<IteratorResult<EngineEvent>> {
              unsubscribe();
              piAgent.abort();
              if (currentPiAgent === piAgent) {
                currentPiAgent = undefined;
              }
              return { done: true, value: undefined };
            },
          };
        },
      };
    },

    steer(text: string): void {
      if (currentPiAgent) {
        const msg: UserMessage = { role: "user", content: text, timestamp: Date.now() };
        currentPiAgent.steer(msg);
      }
    },

    followUp(text: string): void {
      if (currentPiAgent) {
        const msg: UserMessage = { role: "user", content: text, timestamp: Date.now() };
        currentPiAgent.followUp(msg);
      }
    },

    abort(): void {
      if (currentPiAgent) {
        currentPiAgent.abort();
      }
    },

    async dispose(): Promise<void> {
      if (currentPiAgent) {
        currentPiAgent.abort();
        currentPiAgent = undefined;
      }
    },
  };
}
