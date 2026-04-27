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
  getSynthCallTerminal?: () => ModelHandler,
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

  // Synthesize a stream terminal when the adapter doesn't expose a
  // native modelStream. This unifies the engine pipeline so
  // `wrapModelStream` middleware (e.g. @koi/middleware-tool-recovery)
  // runs for every adapter — not just streaming-native ones.
  //
  // The synth resolves `getSynthCallTerminal` per-call when provided.
  // Callers compose this from CALL-ONLY middleware (those that
  // implement wrapModelCall but NOT wrapModelStream) around the raw
  // terminal, so call-only hooks still fire on non-streaming adapters
  // (#review-round14-F1). Dual-hook middleware is excluded from this
  // chain — it fires exactly once via the outer wrapModelStream
  // chain, avoiding the round-13 concurrency-guard self-deadlock and
  // budget double-charge. Each middleware fires exactly once per
  // logical request regardless of adapter shape.
  //
  // Resolved per-call (not captured at construction) so dynamic /
  // forged middleware added after startup are picked up on the next
  // synth invocation (#review-round15-F1).
  //
  // The synth uses raw terminals (not the lifecycle-wrapped
  // `modelHandler`) so the inner call doesn't emit a nested
  // wait(model_call)/resume that would prematurely transition the
  // agent back to `running` while stream middleware is still
  // buffering chunks (#review-round11-F3). The outer
  // `modelStreamHandler` below owns the wait(model_stream)/resume
  // pair for the entire stream lifecycle.
  const effectiveStreamTerminal: ModelStreamHandler =
    rawModelStreamTerminal ??
    async function* (request): AsyncIterable<ModelChunk> {
      const synth = getSynthCallTerminal !== undefined ? getSynthCallTerminal() : rawModelTerminal;
      const response = await synth(request);
      if (response.content.length > 0) {
        yield { kind: "text_delta", delta: response.content };
      }
      // Convert structured blocks from response.richContent into
      // matching stream chunks so non-streaming adapters surface the
      // same observable signals as native streamers. Without this,
      // consumeModelStream — which executes tool calls solely from
      // streamed tool_call_* events — drops calls reported via
      // richContent (#review-round45-F1), and downstream chunk
      // consumers miss thinking blocks (#review-round46-F2).
      if (response.richContent !== undefined) {
        for (const block of response.richContent) {
          if (block.kind === "tool_call") {
            yield { kind: "tool_call_start", toolName: block.name, callId: block.id };
            yield {
              kind: "tool_call_delta",
              callId: block.id,
              delta: JSON.stringify(block.arguments),
            };
            yield { kind: "tool_call_end", callId: block.id };
          } else if (block.kind === "thinking") {
            yield { kind: "thinking_delta", delta: block.text };
          }
          // text blocks are intentionally not re-emitted: response.content
          // is the authoritative aggregate and was already streamed above.
        }
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

  // Compose a chain of CALL-ONLY middleware (wrapModelCall but no
  // wrapModelStream) around the raw terminal. The stream synth uses
  // this so call-only hooks still fire on non-streaming adapters
  // without dual-hook middleware double-firing (#review-round14-F1).
  const callOnly = sorted.filter(
    (mw) => mw.wrapModelCall !== undefined && mw.wrapModelStream === undefined,
  );
  const callOnlyChain = composeModelChain(callOnly, rawModelTerminal);
  const synthCallTerminal: ModelHandler = (request) => callOnlyChain(getTurnContext(), request);

  const { modelHandler, modelStreamHandler, toolHandler } = createTerminalHandlers(
    agent,
    rawModelTerminal,
    rawToolTerminal,
    rawModelStreamTerminal,
    undefined,
    undefined,
    () => synthCallTerminal,
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

  // createTerminalHandlers always returns a modelStreamHandler — either
  // the adapter's native one or a synth around the raw model terminal.
  // So the stream chain is always defined here.
  const streamChain =
    modelStreamHandler !== undefined
      ? composeModelStreamChain(sorted, modelStreamHandler)
      : undefined;

  if (streamChain === undefined) {
    return {
      modelCall: (request) => modelChain(getTurnContext(), prepareRequest(request)),
      toolCall: (request) => toolChain(getTurnContext(), request),
      tools: toolDescriptors,
    };
  }

  return {
    modelCall: (request) => modelChain(getTurnContext(), prepareRequest(request)),
    modelStream: (request) => streamChain(getTurnContext(), prepareRequest(request)),
    toolCall: (request) => toolChain(getTurnContext(), request),
    tools: toolDescriptors,
  };
}
