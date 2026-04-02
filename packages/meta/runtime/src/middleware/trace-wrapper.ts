/**
 * Middleware I/O trace wrapper — wraps any KoiMiddleware to record
 * every hook invocation as an ATIF trajectory step.
 *
 * Self-contained: writes directly to the trajectory store.
 * Generic: works with any middleware, captures everything automatically.
 * Transparent: doesn't change middleware behavior, just observes.
 *
 * Captured per invocation:
 *   - middleware name, phase, priority
 *   - hook name (wrapModelCall, wrapToolCall, wrapModelStream)
 *   - request preview (message text or tool args)
 *   - response preview (model output or tool result)
 *   - duration (ms)
 *   - whether next() was called
 *   - outcome (success/failure)
 *   - error message on failure
 */

import type {
  JsonObject,
  KoiMiddleware,
  ModelChunk,
  ModelHandler,
  ModelRequest,
  ModelResponse,
  ModelStreamHandler,
  RichTrajectoryStep,
  ToolHandler,
  ToolRequest,
  ToolResponse,
  TrajectoryDocumentStore,
  TurnContext,
} from "@koi/core";

export interface TraceWrapperConfig {
  /** Trajectory store to write middleware span steps. */
  readonly store: TrajectoryDocumentStore;
  /** Document ID for trajectory recording. */
  readonly docId: string;
}

/**
 * Wraps a middleware to record every hook invocation as an ATIF trajectory step.
 * The wrapped middleware behaves identically — this is pure observation.
 *
 * Apply to all middleware before passing to createKoi() or recomposeChains():
 *   const traced = middleware.map(mw => wrapMiddlewareWithTrace(mw, config));
 */
/** Middleware names excluded from trace wrapping (trajectory recorders themselves). */
const TRACE_EXCLUDED: ReadonlySet<string> = new Set(["event-trace"]);

export function wrapMiddlewareWithTrace(
  mw: KoiMiddleware,
  config: TraceWrapperConfig,
): KoiMiddleware {
  // Don't trace the trajectory recorder itself — circular and noisy
  if (TRACE_EXCLUDED.has(mw.name)) return mw;
  const { store, docId } = config;

  function recordStep(step: RichTrajectoryStep): void {
    void store.append(docId, [step]).catch(() => {});
  }

  const wrappedModelCall =
    mw.wrapModelCall !== undefined
      ? async (
          ctx: TurnContext,
          request: ModelRequest,
          next: ModelHandler,
        ): Promise<ModelResponse> => {
          const hook = mw.wrapModelCall;
          if (hook === undefined) return next(request);

          const requestPreview = extractModelRequestText(request);
          const start = performance.now();
          // let: mutable — tracks whether next() was called
          let nextCalled = false;
          const trackedNext: ModelHandler = async (req) => {
            nextCalled = true;
            return next(req);
          };

          try {
            const response = await hook(ctx, request, trackedNext);
            recordStep({
              stepIndex: 0,
              timestamp: Date.now(),
              source: "system",
              kind: "model_call",
              identifier: `middleware:${mw.name}`,
              outcome: "success",
              durationMs: performance.now() - start,
              request: { text: requestPreview },
              response: { text: response.content.slice(0, 500) },
              metadata: {
                type: "middleware_span",
                middlewareName: mw.name,
                hook: "wrapModelCall",
                phase: mw.phase ?? "resolve",
                priority: mw.priority ?? 500,
                nextCalled,
              } as JsonObject,
            });
            return response;
          } catch (error: unknown) {
            recordStep({
              stepIndex: 0,
              timestamp: Date.now(),
              source: "system",
              kind: "model_call",
              identifier: `middleware:${mw.name}`,
              outcome: "failure",
              durationMs: performance.now() - start,
              request: { text: requestPreview },
              error: { text: error instanceof Error ? error.message : String(error) },
              metadata: {
                type: "middleware_span",
                middlewareName: mw.name,
                hook: "wrapModelCall",
                phase: mw.phase ?? "resolve",
                priority: mw.priority ?? 500,
                nextCalled,
              } as JsonObject,
            });
            throw error;
          }
        }
      : undefined;

  const wrappedToolCall =
    mw.wrapToolCall !== undefined
      ? async (
          ctx: TurnContext,
          request: ToolRequest,
          next: ToolHandler,
        ): Promise<ToolResponse> => {
          const hook = mw.wrapToolCall;
          if (hook === undefined) return next(request);

          const requestPreview = `${request.toolId}(${JSON.stringify(request.input).slice(0, 300)})`;
          const start = performance.now();
          // let: mutable
          let nextCalled = false;
          const trackedNext: ToolHandler = async (req) => {
            nextCalled = true;
            return next(req);
          };

          try {
            const response = await hook(ctx, request, trackedNext);
            const outputStr =
              typeof response.output === "string"
                ? response.output
                : JSON.stringify(response.output);
            recordStep({
              stepIndex: 0,
              timestamp: Date.now(),
              source: "system",
              kind: "model_call",
              identifier: `middleware:${mw.name}`,
              outcome: "success",
              durationMs: performance.now() - start,
              request: { text: requestPreview },
              response: { text: outputStr.slice(0, 500) },
              metadata: {
                type: "middleware_span",
                middlewareName: mw.name,
                hook: "wrapToolCall",
                phase: mw.phase ?? "resolve",
                priority: mw.priority ?? 500,
                nextCalled,
              } as JsonObject,
            });
            return response;
          } catch (error: unknown) {
            recordStep({
              stepIndex: 0,
              timestamp: Date.now(),
              source: "system",
              kind: "model_call",
              identifier: `middleware:${mw.name}`,
              outcome: "failure",
              durationMs: performance.now() - start,
              request: { text: requestPreview },
              error: { text: error instanceof Error ? error.message : String(error) },
              metadata: {
                type: "middleware_span",
                middlewareName: mw.name,
                hook: "wrapToolCall",
                phase: mw.phase ?? "resolve",
                priority: mw.priority ?? 500,
                nextCalled,
              } as JsonObject,
            });
            throw error;
          }
        }
      : undefined;

  const wrappedModelStream =
    mw.wrapModelStream !== undefined
      ? (
          ctx: TurnContext,
          request: ModelRequest,
          next: ModelStreamHandler,
        ): AsyncIterable<ModelChunk> => {
          const hook = mw.wrapModelStream;
          if (hook === undefined) return next(request);

          const requestPreview = extractModelRequestText(request);
          const start = performance.now();

          // Wrap the stream to record on completion, tracking success/failure/abort
          const inner = hook(ctx, request, next);
          return wrapStreamForTrace(inner, (outcome, errorMessage) => {
            recordStep({
              stepIndex: 0,
              timestamp: Date.now(),
              source: "system",
              kind: "model_call",
              identifier: `middleware:${mw.name}`,
              outcome,
              durationMs: performance.now() - start,
              request: { text: requestPreview },
              metadata: {
                type: "middleware_span",
                middlewareName: mw.name,
                hook: "wrapModelStream",
                phase: mw.phase ?? "resolve",
                priority: mw.priority ?? 500,
                nextCalled: true,
                ...(errorMessage !== undefined ? { error: errorMessage } : {}),
              } as JsonObject,
            });
          });
        }
      : undefined;

  return {
    ...mw,
    ...(wrappedModelCall !== undefined ? { wrapModelCall: wrappedModelCall } : {}),
    ...(wrappedToolCall !== undefined ? { wrapToolCall: wrappedToolCall } : {}),
    ...(wrappedModelStream !== undefined ? { wrapModelStream: wrappedModelStream } : {}),
  };
}

/** Extract readable text from a ModelRequest's messages. */
function extractModelRequestText(request: ModelRequest): string {
  const parts: string[] = [];
  for (const msg of request.messages) {
    for (const block of msg.content) {
      if (block.kind === "text") parts.push(block.text);
    }
  }
  const full = parts.join("\n");
  return full.length <= 500 ? full : `${full.slice(0, 500)}…`;
}

/** Passthrough wrapper that records stream outcome (success/failure/interrupted). */
async function* wrapStreamForTrace(
  inner: AsyncIterable<ModelChunk>,
  onComplete: (outcome: "success" | "failure", errorMessage?: string) => void,
): AsyncIterable<ModelChunk> {
  // let: mutable — tracks whether onComplete was already called
  let recorded = false;
  try {
    yield* inner;
    recorded = true;
    onComplete("success");
  } catch (error: unknown) {
    recorded = true;
    const message = error instanceof Error ? error.message : String(error);
    const isAbort = error instanceof DOMException && error.name === "AbortError";
    onComplete("failure", isAbort ? "interrupted" : message);
    throw error;
  } finally {
    // Generator abandoned (return() called without exhaustion or throw)
    if (!recorded) {
      onComplete("failure", "stream abandoned");
    }
  }
}
