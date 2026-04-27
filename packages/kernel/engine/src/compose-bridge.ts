/**
 * Compose bridge — lifecycle-aware terminal handlers and composed call handlers.
 *
 * These functions bridge the pure composition layer (@koi/engine-compose) with
 * the AgentEntity, adding lifecycle transitions (running↔waiting) around
 * model/tool calls.
 */

import type {
  ComposedCallHandlers,
  KoiMiddleware,
  ModelChunk,
  ModelHandler,
  ModelRequest,
  ModelStreamHandler,
  Tool,
  ToolDescriptor,
  ToolHandler,
  TurnContext,
} from "@koi/core";
import type {
  CapabilityInjectionConfig,
  DebugInstrumentation,
  TerminalHandlers,
} from "@koi/engine-compose";
import {
  composeModelChain,
  composeModelStreamChain,
  composeToolChain,
  injectCapabilities,
  sortMiddlewareByPhase,
} from "@koi/engine-compose";
import type { AgentEntity } from "./agent-entity.js";

// ---------------------------------------------------------------------------
// Lifecycle-aware terminal handlers
// ---------------------------------------------------------------------------

/**
 * Wraps raw model/tool terminals with lifecycle transitions:
 * running → waiting("model_call"|"tool_call"|"model_stream") before call,
 * waiting → running (resume) after call, even on error.
 */
export function createTerminalHandlers(
  agent: AgentEntity,
  rawModelTerminal: ModelHandler,
  rawToolTerminal: ToolHandler,
  rawModelStreamTerminal?: ModelStreamHandler,
  debugInstrumentation?: DebugInstrumentation,
  getTurnIndex?: () => number,
): TerminalHandlers {
  const modelHandler: ModelHandler = async (request) => {
    agent.transition({ kind: "wait", reason: "model_call" });
    const ioStart = performance.now();
    try {
      return await rawModelTerminal(request);
    } finally {
      agent.transition({ kind: "resume" });
      if (debugInstrumentation !== undefined && getTurnIndex !== undefined) {
        debugInstrumentation.recordChannelIO({
          direction: "out",
          kind: "model_call",
          durationMs: performance.now() - ioStart,
          turnIndex: getTurnIndex(),
        });
      }
    }
  };

  const toolHandler: ToolHandler = async (request) => {
    agent.transition({ kind: "wait", reason: "tool_call" });
    const ioStart = performance.now();
    try {
      return await rawToolTerminal(request);
    } finally {
      agent.transition({ kind: "resume" });
      if (debugInstrumentation !== undefined && getTurnIndex !== undefined) {
        debugInstrumentation.recordChannelIO({
          direction: "out",
          kind: "tool_call",
          durationMs: performance.now() - ioStart,
          turnIndex: getTurnIndex(),
        });
      }
    }
  };

  // Synthesize a stream terminal from the (lifecycle-wrapped) modelHandler
  // when the adapter doesn't expose a native modelStream. This unifies the
  // engine pipeline so `wrapModelStream` middleware (e.g.
  // @koi/middleware-tool-recovery) runs for every adapter — not just
  // streaming-native ones. The synthetic terminal calls the raw modelCall,
  // then yields a text_delta per text content block followed by a single
  // done chunk. Stream-middleware composition above (recomposeChains)
  // wraps this with all `wrapModelStream` middleware, in priority order.
  const effectiveStreamTerminal: ModelStreamHandler =
    rawModelStreamTerminal ??
    async function* (request): AsyncIterable<ModelChunk> {
      const response = await modelHandler(request);
      if (response.content.length > 0) {
        yield { kind: "text_delta", delta: response.content };
      }
      yield { kind: "done", response };
    };

  const modelStreamHandler: ModelStreamHandler = (request) => {
    let finished = false;
    const streamStart = performance.now();

    function resume(): void {
      if (!finished) {
        finished = true;
        agent.transition({ kind: "resume" });
        if (debugInstrumentation !== undefined && getTurnIndex !== undefined) {
          debugInstrumentation.recordChannelIO({
            direction: "out",
            kind: "model_stream",
            durationMs: performance.now() - streamStart,
            turnIndex: getTurnIndex(),
          });
        }
      }
    }

    return {
      [Symbol.asyncIterator](): AsyncIterator<ModelChunk> {
        agent.transition({ kind: "wait", reason: "model_stream" });
        const inner = effectiveStreamTerminal(request)[Symbol.asyncIterator]();

        return {
          async next(): Promise<IteratorResult<ModelChunk>> {
            try {
              const result = await inner.next();
              if (result.done) {
                resume();
              }
              return result;
            } catch (error: unknown) {
              resume();
              throw error;
            }
          },
          async return(): Promise<IteratorResult<ModelChunk>> {
            resume();
            if (inner.return) {
              return inner.return();
            }
            return { done: true, value: undefined };
          },
        };
      },
    };
  };

  return { modelHandler, modelStreamHandler, toolHandler };
}

// ---------------------------------------------------------------------------
// Composed call handlers (full pipeline with AgentEntity)
// ---------------------------------------------------------------------------

/**
 * Composes middleware chains around lifecycle-aware terminals,
 * producing a ComposedCallHandlers that adapters invoke at defined points.
 *
 * Accepts a `getTurnContext` thunk so the turn context is resolved at call time,
 * not at creation time — avoids stale turnIndex after turn_end events.
 */
export function createComposedCallHandlers(
  middleware: readonly KoiMiddleware[],
  getTurnContext: () => TurnContext,
  agent: AgentEntity,
  rawModelTerminal: ModelHandler,
  rawToolTerminal: ToolHandler,
  rawModelStreamTerminal?: ModelStreamHandler,
  capabilityConfig?: CapabilityInjectionConfig,
): ComposedCallHandlers {
  const sorted = sortMiddlewareByPhase(middleware);

  const { modelHandler, modelStreamHandler, toolHandler } = createTerminalHandlers(
    agent,
    rawModelTerminal,
    rawToolTerminal,
    rawModelStreamTerminal,
  );

  const modelChain = composeModelChain(sorted, modelHandler);
  const toolChain = composeToolChain(sorted, toolHandler);

  // Extract tool descriptors from the agent's ECS components
  const toolComponents = agent.query<Tool>("tool:");
  const toolDescriptors: readonly ToolDescriptor[] = [...toolComponents.values()].map(
    (t) => t.descriptor,
  );

  // Inject tool descriptors into ModelRequest so middleware can see/filter tools.
  // If the request already carries tools (e.g., set by a prior layer), preserve them.
  const injectTools = (request: ModelRequest): ModelRequest =>
    request.tools !== undefined ? request : { ...request, tools: toolDescriptors };

  const prepareRequest = (request: ModelRequest): ModelRequest => {
    const withTools = injectTools(request);
    return injectCapabilities(sorted, getTurnContext(), withTools, capabilityConfig);
  };

  if (modelStreamHandler === undefined) {
    return {
      modelCall: (request) => modelChain(getTurnContext(), prepareRequest(request)),
      toolCall: (request) => toolChain(getTurnContext(), request),
      tools: toolDescriptors,
    };
  }

  const streamChain = composeModelStreamChain(sorted, modelStreamHandler);

  return {
    modelCall: (request) => modelChain(getTurnContext(), prepareRequest(request)),
    modelStream: (request) => streamChain(getTurnContext(), prepareRequest(request)),
    toolCall: (request) => toolChain(getTurnContext(), request),
    tools: toolDescriptors,
  };
}
