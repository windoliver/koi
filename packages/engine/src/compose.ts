/**
 * Middleware composition — onion chain for model/tool calls, linear runner for hooks.
 *
 * composeModelChain: wraps wrapModelCall hooks into an onion around the terminal handler.
 * composeToolChain: wraps wrapToolCall hooks into an onion around the terminal handler.
 * runSessionHooks / runTurnHooks: runs lifecycle hooks sequentially with type safety.
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
  Tool,
  ToolDescriptor,
  ToolHandler,
  ToolRequest,
  ToolResponse,
  TurnContext,
} from "@koi/core";
import type { AgentEntity } from "./agent-entity.js";

// ---------------------------------------------------------------------------
// Generic onion composition
// ---------------------------------------------------------------------------

/** A middleware hook extracted for the generic onion chain. */
interface OnionEntry<Req, Res> {
  readonly name: string;
  readonly hook: (ctx: TurnContext, request: Req, next: (req: Req) => Res) => Res;
}

/**
 * Builds an onion-style dispatch chain from a list of hook entries and a terminal.
 * Each hook wraps the next, with double-call detection on every layer.
 *
 * The optional `wrapNextResult` callback enables retry-on-error: it hooks into
 * the result of the inner chain and resets the double-call guard when that result
 * signals an error. This allows middleware (e.g., overflow recovery) to call
 * `next()` again after catching an error, while still preventing accidental
 * double-calls on the success path.
 */
function composeOnion<Req, Res>(
  entries: readonly OnionEntry<Req, Res>[],
  hookLabel: string,
  terminal: (req: Req) => Res,
  wrapNextResult?: (result: Res, resetGuard: () => void) => Res,
): (ctx: TurnContext, request: Req) => Res {
  return (ctx: TurnContext, request: Req): Res => {
    const dispatch = (i: number, req: Req): Res => {
      const entry = entries[i];
      if (entry === undefined) {
        return terminal(req);
      }
      // let required: toggled by next(), reset on error by wrapNextResult
      let called = false;
      const next = (nextReq: Req): Res => {
        if (called) {
          throw new Error(
            `Middleware "${entry.name}" called next() multiple times in ${hookLabel}`,
          );
        }
        called = true;
        const result = dispatch(i + 1, nextReq);
        if (wrapNextResult !== undefined) {
          return wrapNextResult(result, () => {
            called = false;
          });
        }
        return result;
      };
      return entry.hook(ctx, req, next);
    };
    return dispatch(0, request);
  };
}

// ---------------------------------------------------------------------------
// Async iterable wrapper for retry-on-error
// ---------------------------------------------------------------------------

/**
 * Wraps an AsyncIterable to call `onError` when iteration throws.
 * Used by composeModelStreamChain to reset the double-call guard,
 * enabling middleware retry patterns (e.g., overflow recovery).
 */
function wrapAsyncIterableWithErrorReset<T>(
  iterable: AsyncIterable<T>,
  onError: () => void,
): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<T> {
      const inner = iterable[Symbol.asyncIterator]();
      return {
        async next(): Promise<IteratorResult<T>> {
          try {
            return await inner.next();
          } catch (error: unknown) {
            onError();
            throw error;
          }
        },
        async return(value?: unknown): Promise<IteratorResult<T>> {
          if (inner.return !== undefined) {
            return inner.return(value) as Promise<IteratorResult<T>>;
          }
          return { done: true as const, value: undefined as T };
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Type-safe onion wrappers
// ---------------------------------------------------------------------------

export function composeModelChain(
  middleware: readonly KoiMiddleware[],
  terminal: ModelHandler,
): (ctx: TurnContext, request: ModelRequest) => Promise<ModelResponse> {
  const entries: OnionEntry<ModelRequest, Promise<ModelResponse>>[] = [];
  for (const mw of middleware) {
    if (mw.wrapModelCall !== undefined) {
      entries.push({ name: mw.name, hook: mw.wrapModelCall });
    }
  }
  return composeOnion(entries, "wrapModelCall", terminal, (result, resetGuard) => {
    // Reset double-call guard on rejection to allow retry-on-error.
    // The .catch() handler runs before the caller's await-catch (Promise microtask ordering:
    // handlers registered first are invoked first for the same rejected Promise).
    void result.catch(() => {
      resetGuard();
    });
    return result;
  });
}

export function composeModelStreamChain(
  middleware: readonly KoiMiddleware[],
  terminal: ModelStreamHandler,
): (ctx: TurnContext, request: ModelRequest) => AsyncIterable<ModelChunk> {
  const entries: OnionEntry<ModelRequest, AsyncIterable<ModelChunk>>[] = [];
  for (const mw of middleware) {
    if (mw.wrapModelStream !== undefined) {
      entries.push({ name: mw.name, hook: mw.wrapModelStream });
    }
  }
  return composeOnion(entries, "wrapModelStream", terminal, (result, resetGuard) => {
    // Wrap the iterable to reset the double-call guard when iteration fails.
    // This allows middleware (e.g., overflow recovery) to retry after catching
    // a stream error, while still blocking accidental double-calls on success.
    return wrapAsyncIterableWithErrorReset(result, resetGuard);
  });
}

export function composeToolChain(
  middleware: readonly KoiMiddleware[],
  terminal: ToolHandler,
): (ctx: TurnContext, request: ToolRequest) => Promise<ToolResponse> {
  const entries: OnionEntry<ToolRequest, Promise<ToolResponse>>[] = [];
  for (const mw of middleware) {
    if (mw.wrapToolCall !== undefined) {
      entries.push({ name: mw.name, hook: mw.wrapToolCall });
    }
  }
  return composeOnion(entries, "wrapToolCall", terminal);
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

  // Extract tool descriptors from the agent's ECS components
  const toolComponents = agent.query<Tool>("tool:");
  const toolDescriptors: readonly ToolDescriptor[] = [...toolComponents.values()].map(
    (t) => t.descriptor,
  );

  // Inject tool descriptors into ModelRequest so middleware can see/filter tools.
  // If the request already carries tools (e.g., set by a prior layer), preserve them.
  const injectTools = (request: ModelRequest): ModelRequest =>
    request.tools !== undefined ? request : { ...request, tools: toolDescriptors };

  if (modelStreamHandler === undefined) {
    return {
      modelCall: (request) => modelChain(getTurnContext(), injectTools(request)),
      toolCall: (request) => toolChain(getTurnContext(), request),
      tools: toolDescriptors,
    };
  }

  const streamChain = composeModelStreamChain(middleware, modelStreamHandler);

  return {
    modelCall: (request) => modelChain(getTurnContext(), injectTools(request)),
    modelStream: (request) => streamChain(getTurnContext(), injectTools(request)),
    toolCall: (request) => toolChain(getTurnContext(), request),
    tools: toolDescriptors,
  };
}
