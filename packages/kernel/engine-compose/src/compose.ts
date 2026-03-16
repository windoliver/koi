/**
 * Middleware composition — onion chain for model/tool calls, linear runner for hooks.
 *
 * composeModelChain: wraps wrapModelCall hooks into an onion around the terminal handler.
 * composeToolChain: wraps wrapToolCall hooks into an onion around the terminal handler.
 * runSessionHooks / runTurnHooks: runs lifecycle hooks sequentially with type safety.
 */

import type {
  CapabilityFragment,
  InboundMessage,
  KoiMiddleware,
  MiddlewarePhase,
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
import { CHARS_PER_TOKEN } from "@koi/token-estimator";

// ---------------------------------------------------------------------------
// Phase-aware middleware sorting
// ---------------------------------------------------------------------------

/** Phase → numeric tier for sorting. Lower tier = outer onion layer (runs first). */
const PHASE_TIER: Readonly<Record<MiddlewarePhase, number>> = {
  intercept: 0,
  resolve: 1,
  observe: 2,
};

/**
 * Sort middleware by phase tier first, then by priority within the same tier.
 * Default phase is "resolve" (tier 1); default priority is 500.
 * Returns a new sorted array (immutable — does not mutate the input).
 */
export function sortMiddlewareByPhase(
  middleware: readonly KoiMiddleware[],
): readonly KoiMiddleware[] {
  return [...middleware].sort((a, b) => {
    const tierA = PHASE_TIER[a.phase ?? "resolve"];
    const tierB = PHASE_TIER[b.phase ?? "resolve"];
    if (tierA !== tierB) return tierA - tierB;
    return (a.priority ?? 500) - (b.priority ?? 500);
  });
}

// ---------------------------------------------------------------------------
// Middleware merging + chain recomposition
// ---------------------------------------------------------------------------

/**
 * Merge static, forged, and dynamic middleware into a single phase-sorted array.
 * Callers are responsible for identity-check gating (only call when sources change).
 */
export function resolveActiveMiddleware(
  staticMiddleware: readonly KoiMiddleware[],
  forgedMiddleware?: readonly KoiMiddleware[],
  dynamicMiddleware?: readonly KoiMiddleware[],
): readonly KoiMiddleware[] {
  if (forgedMiddleware === undefined && dynamicMiddleware === undefined) {
    return sortMiddlewareByPhase(staticMiddleware);
  }
  return sortMiddlewareByPhase([
    ...staticMiddleware,
    ...(forgedMiddleware ?? []),
    ...(dynamicMiddleware ?? []),
  ]);
}

/** Terminal handler references returned by recomposeChains. */
export interface RecomposedChains {
  readonly toolChain: (ctx: TurnContext, request: ToolRequest) => Promise<ToolResponse>;
  readonly modelChain: (ctx: TurnContext, request: ModelRequest) => Promise<ModelResponse>;
  readonly streamChain:
    | ((ctx: TurnContext, request: ModelRequest) => AsyncIterable<ModelChunk>)
    | undefined;
}

export interface TerminalHandlers {
  readonly modelHandler: ModelHandler;
  readonly modelStreamHandler?: ModelStreamHandler;
  readonly toolHandler: ToolHandler;
}

/**
 * Compose tool, model, and optional stream chains from sorted middleware + terminals.
 * Does NOT sort — caller must pass pre-sorted middleware (from resolveActiveMiddleware).
 */
export function recomposeChains(
  sortedMiddleware: readonly KoiMiddleware[],
  terminals: TerminalHandlers,
): RecomposedChains {
  const toolChain = composeToolChain(sortedMiddleware, terminals.toolHandler);
  const modelChain = composeModelChain(sortedMiddleware, terminals.modelHandler);
  const streamChain =
    terminals.modelStreamHandler !== undefined
      ? composeModelStreamChain(sortedMiddleware, terminals.modelStreamHandler)
      : undefined;
  return { toolChain, modelChain, streamChain };
}

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
  terminal: (req: Req, ctx: TurnContext) => Res,
  wrapNextResult?: (result: Res, resetGuard: () => void) => Res,
): (ctx: TurnContext, request: Req) => Res {
  return (ctx: TurnContext, request: Req): Res => {
    const dispatch = (i: number, req: Req): Res => {
      const entry = entries[i];
      if (entry === undefined) {
        return terminal(req, ctx);
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
  const regularEntries: OnionEntry<ModelRequest, Promise<ModelResponse>>[] = [];
  const concurrentObservers: KoiMiddleware[] = [];

  for (const mw of middleware) {
    if (mw.wrapModelCall === undefined) continue;
    if (mw.concurrent === true && (mw.phase ?? "resolve") === "observe") {
      concurrentObservers.push(mw);
    } else {
      regularEntries.push({ name: mw.name, hook: mw.wrapModelCall });
    }
  }

  // Wrap external terminal to match (req, ctx) signature
  const wrappedTerminal = (req: ModelRequest, _ctx: TurnContext): Promise<ModelResponse> =>
    terminal(req);

  if (concurrentObservers.length === 0) {
    return composeOnion(regularEntries, "wrapModelCall", wrappedTerminal, (result, resetGuard) => {
      void result.catch(() => {
        resetGuard();
      });
      return result;
    });
  }

  // Terminal that fires concurrent observers with the ctx it receives from the onion.
  // ctx flows through composeOnion's dispatch closure — no shared mutable state, no WeakMap.
  const observingTerminal = (req: ModelRequest, ctx: TurnContext): Promise<ModelResponse> => {
    const result = terminal(req);
    fireConcurrentModelObservers(concurrentObservers, ctx, req, result);
    return result;
  };

  return composeOnion(regularEntries, "wrapModelCall", observingTerminal, (result, resetGuard) => {
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
  // Streams: all middleware runs sequentially (including concurrent observers).
  // Concurrent observe is only meaningful for request/response (model call, tool call),
  // not for streams — observers can't inspect chunks from an empty async iterable.
  const entries: OnionEntry<ModelRequest, AsyncIterable<ModelChunk>>[] = [];
  for (const mw of middleware) {
    if (mw.wrapModelStream !== undefined) {
      entries.push({ name: mw.name, hook: mw.wrapModelStream });
    }
  }
  const wrappedTerminal = (req: ModelRequest, _ctx: TurnContext): AsyncIterable<ModelChunk> =>
    terminal(req);
  return composeOnion(entries, "wrapModelStream", wrappedTerminal, (result, resetGuard) => {
    return wrapAsyncIterableWithErrorReset(result, resetGuard);
  });
}

export function composeToolChain(
  middleware: readonly KoiMiddleware[],
  terminal: ToolHandler,
): (ctx: TurnContext, request: ToolRequest) => Promise<ToolResponse> {
  const regularEntries: OnionEntry<ToolRequest, Promise<ToolResponse>>[] = [];
  const concurrentObservers: KoiMiddleware[] = [];

  for (const mw of middleware) {
    if (mw.wrapToolCall === undefined) continue;
    if (mw.concurrent === true && (mw.phase ?? "resolve") === "observe") {
      concurrentObservers.push(mw);
    } else {
      regularEntries.push({ name: mw.name, hook: mw.wrapToolCall });
    }
  }

  const wrappedTerminal = (req: ToolRequest, _ctx: TurnContext): Promise<ToolResponse> =>
    terminal(req);

  if (concurrentObservers.length === 0) {
    return composeOnion(regularEntries, "wrapToolCall", wrappedTerminal);
  }

  const observingTerminal = (req: ToolRequest, ctx: TurnContext): Promise<ToolResponse> => {
    const result = terminal(req);
    fireConcurrentToolObservers(concurrentObservers, ctx, req, result);
    return result;
  };

  return composeOnion(regularEntries, "wrapToolCall", observingTerminal);
}

// ---------------------------------------------------------------------------
// Concurrent observer helpers (P2-A race pattern)
// ---------------------------------------------------------------------------

/**
 * Fire concurrent model-call observers alongside the terminal result.
 * Called from the observing terminal wrapper, so observers see the
 * post-rewrite request (after intercept/resolve middleware).
 * Observer errors are silently swallowed — they're observe-only.
 */
function fireConcurrentModelObservers(
  observers: readonly KoiMiddleware[],
  ctx: TurnContext,
  request: ModelRequest,
  mainResult: Promise<ModelResponse>,
): void {
  for (const mw of observers) {
    if (mw.wrapModelCall === undefined) continue;
    const next = (): Promise<ModelResponse> => mainResult;
    try {
      const observerPromise = mw.wrapModelCall(ctx, request, next);
      void observerPromise.catch(() => {});
    } catch (_observeError: unknown) {
      // Synchronous throw in observer — swallow
    }
  }
}

/**
 * Fire concurrent tool-call observers alongside the main chain result.
 */
function fireConcurrentToolObservers(
  observers: readonly KoiMiddleware[],
  ctx: TurnContext,
  request: ToolRequest,
  mainResult: Promise<ToolResponse>,
): void {
  for (const mw of observers) {
    if (mw.wrapToolCall === undefined) continue;
    const next = (): Promise<ToolResponse> => mainResult;
    try {
      const observerPromise = mw.wrapToolCall(ctx, request, next);
      void observerPromise.catch(() => {});
    } catch (_observeError: unknown) {
      // Synchronous throw in observer — swallow
    }
  }
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
// Capability injection — self-describing middleware
// ---------------------------------------------------------------------------

export interface CapabilityInjectionConfig {
  /** Maximum estimated tokens for the capability message. Fragments truncated from the end when exceeded. */
  readonly maxCapabilityTokens?: number;
}

/**
 * Collects capability descriptions from all middleware that implement `describeCapabilities`.
 * Each call is wrapped in try/catch — errors are logged and the middleware is skipped.
 */
export function collectCapabilities(
  middleware: readonly KoiMiddleware[],
  ctx: TurnContext,
): readonly CapabilityFragment[] {
  const fragments: CapabilityFragment[] = [];
  for (const mw of middleware) {
    if (mw.describeCapabilities === undefined) continue;
    try {
      const fragment = mw.describeCapabilities(ctx);
      if (fragment !== undefined) {
        fragments.push(fragment);
      }
    } catch (e: unknown) {
      console.warn(
        `Middleware "${mw.name}" threw in describeCapabilities, skipping:`,
        e instanceof Error ? e.message : e,
      );
    }
  }
  return fragments;
}

/**
 * Formats collected capability fragments into an InboundMessage.
 * Assumes fragments is non-empty — caller must check.
 */
export function formatCapabilityMessage(fragments: readonly CapabilityFragment[]): InboundMessage {
  const lines = fragments.map((f) => `- **${f.label}**: ${f.description}`);
  const text = `[Active Capabilities]\n${lines.join("\n")}`;
  return {
    senderId: "system:capabilities",
    timestamp: Date.now(),
    content: [{ kind: "text", text }],
  };
}

/** Heuristic token estimate using the canonical chars-per-token constant. */
function estimateTokensFromChars(charCount: number): number {
  return Math.ceil(charCount / CHARS_PER_TOKEN);
}

/**
 * Injects capability descriptions into a ModelRequest. Returns the request unchanged
 * if no middleware provides descriptions (zero-allocation fast-path).
 */
export function injectCapabilities(
  middleware: readonly KoiMiddleware[],
  ctx: TurnContext,
  request: ModelRequest,
  config?: CapabilityInjectionConfig,
): ModelRequest {
  const allFragments = collectCapabilities(middleware, ctx);
  if (allFragments.length === 0) return request;

  // Apply maxCapabilityTokens truncation from the end
  let fragments: readonly CapabilityFragment[];
  if (config?.maxCapabilityTokens !== undefined) {
    let totalChars = "[Active Capabilities]\n".length;
    const kept: CapabilityFragment[] = [];
    for (const f of allFragments) {
      const lineChars = `- **${f.label}**: ${f.description}\n`.length;
      if (estimateTokensFromChars(totalChars + lineChars) > config.maxCapabilityTokens) break;
      totalChars += lineChars;
      kept.push(f);
    }
    if (kept.length === 0) return request;
    fragments = kept;
  } else {
    fragments = allFragments;
  }

  const message = formatCapabilityMessage(fragments);
  return { ...request, messages: [message, ...request.messages] };
}
