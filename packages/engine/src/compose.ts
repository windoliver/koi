/**
 * Middleware composition — onion chain for model/tool calls, linear runner for hooks.
 *
 * composeModelChain: wraps wrapModelCall hooks into an onion around the terminal handler.
 * composeToolChain: wraps wrapToolCall hooks into an onion around the terminal handler.
 * runHooks: runs lifecycle hooks (onSessionStart, onBeforeTurn, etc.) sequentially.
 */

import type {
  ComposedCallHandlers,
  KoiMiddleware,
  ModelChunk,
  ModelHandler,
  ModelRequest,
  ModelResponse,
  ModelStreamHandler,
  SessionContext,
  ToolHandler,
  ToolRequest,
  ToolResponse,
  TurnContext,
} from "@koi/core";
import type { AgentEntity } from "./agent-entity.js";

// ---------------------------------------------------------------------------
// Onion composition for model calls
// ---------------------------------------------------------------------------

export function composeModelChain(
  middleware: readonly KoiMiddleware[],
  terminal: ModelHandler,
): (ctx: TurnContext, request: ModelRequest) => Promise<ModelResponse> {
  // Collect middleware that have wrapModelCall defined
  const wrappers = middleware.filter(
    (
      mw,
    ): mw is KoiMiddleware & {
      readonly wrapModelCall: NonNullable<KoiMiddleware["wrapModelCall"]>;
    } => mw.wrapModelCall !== undefined,
  );

  return (ctx: TurnContext, request: ModelRequest): Promise<ModelResponse> => {
    const dispatch = (i: number, req: ModelRequest): Promise<ModelResponse> => {
      const wrapper = wrappers[i];
      if (wrapper === undefined) {
        return terminal(req);
      }
      let called = false;
      const next: ModelHandler = (nextReq: ModelRequest): Promise<ModelResponse> => {
        if (called) {
          throw new Error(
            `Middleware "${wrapper.name}" called next() multiple times in wrapModelCall`,
          );
        }
        called = true;
        return dispatch(i + 1, nextReq);
      };
      return wrapper.wrapModelCall(ctx, req, next);
    };
    return dispatch(0, request);
  };
}

// ---------------------------------------------------------------------------
// Onion composition for model streams
// ---------------------------------------------------------------------------

export function composeModelStreamChain(
  middleware: readonly KoiMiddleware[],
  terminal: ModelStreamHandler,
): (ctx: TurnContext, request: ModelRequest) => AsyncIterable<ModelChunk> {
  const wrappers = middleware.filter(
    (
      mw,
    ): mw is KoiMiddleware & {
      readonly wrapModelStream: NonNullable<KoiMiddleware["wrapModelStream"]>;
    } => mw.wrapModelStream !== undefined,
  );

  return (ctx: TurnContext, request: ModelRequest): AsyncIterable<ModelChunk> => {
    const dispatch = (i: number, req: ModelRequest): AsyncIterable<ModelChunk> => {
      const wrapper = wrappers[i];
      if (wrapper === undefined) {
        return terminal(req);
      }
      let called = false;
      const next: ModelStreamHandler = (nextReq: ModelRequest): AsyncIterable<ModelChunk> => {
        if (called) {
          throw new Error(
            `Middleware "${wrapper.name}" called next() multiple times in wrapModelStream`,
          );
        }
        called = true;
        return dispatch(i + 1, nextReq);
      };
      return wrapper.wrapModelStream(ctx, req, next);
    };
    return dispatch(0, request);
  };
}

// ---------------------------------------------------------------------------
// Onion composition for tool calls
// ---------------------------------------------------------------------------

export function composeToolChain(
  middleware: readonly KoiMiddleware[],
  terminal: ToolHandler,
): (ctx: TurnContext, request: ToolRequest) => Promise<ToolResponse> {
  const wrappers = middleware.filter(
    (
      mw,
    ): mw is KoiMiddleware & {
      readonly wrapToolCall: NonNullable<KoiMiddleware["wrapToolCall"]>;
    } => mw.wrapToolCall !== undefined,
  );

  return (ctx: TurnContext, request: ToolRequest): Promise<ToolResponse> => {
    const dispatch = (i: number, req: ToolRequest): Promise<ToolResponse> => {
      const wrapper = wrappers[i];
      if (wrapper === undefined) {
        return terminal(req);
      }
      let called = false;
      const next: ToolHandler = (nextReq: ToolRequest): Promise<ToolResponse> => {
        if (called) {
          throw new Error(
            `Middleware "${wrapper.name}" called next() multiple times in wrapToolCall`,
          );
        }
        called = true;
        return dispatch(i + 1, nextReq);
      };
      return wrapper.wrapToolCall(ctx, req, next);
    };
    return dispatch(0, request);
  };
}

// ---------------------------------------------------------------------------
// Linear hook runner
// ---------------------------------------------------------------------------

type SessionHook = "onSessionStart" | "onSessionEnd";
type TurnHook = "onBeforeTurn" | "onAfterTurn";

export async function runSessionHooks(
  middleware: readonly KoiMiddleware[],
  hookName: SessionHook,
  ctx: SessionContext,
): Promise<void> {
  for (const mw of middleware) {
    const hook = mw[hookName];
    if (hook) {
      await hook(ctx);
    }
  }
}

export async function runTurnHooks(
  middleware: readonly KoiMiddleware[],
  hookName: TurnHook,
  ctx: TurnContext,
): Promise<void> {
  for (const mw of middleware) {
    const hook = mw[hookName];
    if (hook) {
      await hook(ctx);
    }
  }
}

// ---------------------------------------------------------------------------
// Lifecycle-aware terminal handlers
// ---------------------------------------------------------------------------

export interface TerminalHandlers {
  readonly modelHandler: ModelHandler;
  readonly modelStreamHandler?: ModelStreamHandler;
  readonly toolHandler: ToolHandler;
}

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
): TerminalHandlers {
  const modelHandler: ModelHandler = async (request) => {
    agent.transition({ kind: "wait", reason: "model_call" });
    try {
      return await rawModelTerminal(request);
    } finally {
      agent.transition({ kind: "resume" });
    }
  };

  const toolHandler: ToolHandler = async (request) => {
    agent.transition({ kind: "wait", reason: "tool_call" });
    try {
      return await rawToolTerminal(request);
    } finally {
      agent.transition({ kind: "resume" });
    }
  };

  if (rawModelStreamTerminal === undefined) {
    return { modelHandler, toolHandler };
  }

  const modelStreamHandler: ModelStreamHandler = (request) => {
    let finished = false;

    function resume(): void {
      if (!finished) {
        finished = true;
        agent.transition({ kind: "resume" });
      }
    }

    return {
      [Symbol.asyncIterator](): AsyncIterator<ModelChunk> {
        agent.transition({ kind: "wait", reason: "model_stream" });
        const inner = rawModelStreamTerminal(request)[Symbol.asyncIterator]();

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
): ComposedCallHandlers {
  const { modelHandler, modelStreamHandler, toolHandler } = createTerminalHandlers(
    agent,
    rawModelTerminal,
    rawToolTerminal,
    rawModelStreamTerminal,
  );

  const modelChain = composeModelChain(middleware, modelHandler);
  const toolChain = composeToolChain(middleware, toolHandler);

  if (modelStreamHandler === undefined) {
    return {
      modelCall: (request) => modelChain(getTurnContext(), request),
      toolCall: (request) => toolChain(getTurnContext(), request),
    };
  }

  const streamChain = composeModelStreamChain(middleware, modelStreamHandler);

  return {
    modelCall: (request) => modelChain(getTurnContext(), request),
    modelStream: (request) => streamChain(getTurnContext(), request),
    toolCall: (request) => toolChain(getTurnContext(), request),
  };
}

/**
 * @deprecated Use runSessionHooks or runTurnHooks for type safety.
 * This is a convenience alias that accepts either context type.
 */
export async function runHooks(
  middleware: readonly KoiMiddleware[],
  hookName: SessionHook | TurnHook,
  ctx: SessionContext | TurnContext,
): Promise<void> {
  for (const mw of middleware) {
    const hook = mw[hookName] as ((ctx: never) => Promise<void>) | undefined;
    if (hook) {
      await hook(ctx as never);
    }
  }
}
