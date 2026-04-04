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
  /**
   * When true, records shallow diffs of request modifications by middleware.
   * Captures what each middleware changed in model requests and tool inputs.
   * Default: false (no overhead).
   */
  readonly captureDeltas?: boolean;
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
  const { store, docId, captureDeltas } = config;

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
          // let: mutable — tracks whether next() was called and captures modified request
          let nextCalled = false;
          let capturedRequest: ModelRequest | undefined;
          const trackedNext: ModelHandler = async (req) => {
            nextCalled = true;
            if (captureDeltas === true) capturedRequest = req;
            return next(req);
          };

          try {
            const response = await hook(ctx, request, trackedNext);
            const deltaMeta =
              captureDeltas === true && capturedRequest !== undefined && capturedRequest !== request
                ? computeRequestDelta(request, capturedRequest)
                : undefined;
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
                ...(deltaMeta !== undefined ? { requestDelta: deltaMeta } : {}),
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
          // let: mutable — tracks next() call and captures modified request
          let nextCalled = false;
          let capturedInput: JsonObject | undefined;
          const trackedNext: ToolHandler = async (req) => {
            nextCalled = true;
            if (captureDeltas === true) capturedInput = req.input as JsonObject;
            return next(req);
          };

          try {
            const response = await hook(ctx, request, trackedNext);
            const outputStr =
              typeof response.output === "string"
                ? response.output
                : JSON.stringify(response.output);
            const deltaMeta =
              captureDeltas === true &&
              capturedInput !== undefined &&
              capturedInput !== (request.input as JsonObject)
                ? shallowDiff(request.input as JsonObject, capturedInput)
                : undefined;
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
                ...(deltaMeta !== undefined ? { inputDelta: deltaMeta } : {}),
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

/**
 * Shallow diff between two objects. Returns `{ changed, added, removed }` or
 * undefined if objects are identical by reference or have no differences.
 */
function shallowDiff(before: JsonObject, after: JsonObject): JsonObject | undefined {
  const changed: Record<string, { readonly from: unknown; readonly to: unknown }> = {};
  const added: Record<string, unknown> = {};
  const removed: string[] = [];

  for (const key of Object.keys(before)) {
    if (!(key in after)) {
      removed.push(key);
    } else if (before[key] !== after[key]) {
      changed[key] = { from: before[key], to: after[key] };
    }
  }
  for (const key of Object.keys(after)) {
    if (!(key in before)) {
      added[key] = after[key];
    }
  }

  if (
    Object.keys(changed).length === 0 &&
    Object.keys(added).length === 0 &&
    removed.length === 0
  ) {
    return undefined;
  }

  return {
    ...(Object.keys(changed).length > 0 ? { changed } : {}),
    ...(Object.keys(added).length > 0 ? { added } : {}),
    ...(removed.length > 0 ? { removed } : {}),
  } as JsonObject;
}

/**
 * Compute request delta for ModelRequest. Diffs top-level scalar fields
 * (temperature, maxTokens, model, systemPrompt) — ignores messages array
 * since it's typically large and not modified by middleware.
 */
function computeRequestDelta(before: ModelRequest, after: ModelRequest): JsonObject | undefined {
  const beforeFlat: JsonObject = {
    ...(before.temperature !== undefined ? { temperature: before.temperature } : {}),
    ...(before.maxTokens !== undefined ? { maxTokens: before.maxTokens } : {}),
    ...(before.model !== undefined ? { model: before.model } : {}),
    ...(before.systemPrompt !== undefined ? { systemPrompt: before.systemPrompt } : {}),
  };
  const afterFlat: JsonObject = {
    ...(after.temperature !== undefined ? { temperature: after.temperature } : {}),
    ...(after.maxTokens !== undefined ? { maxTokens: after.maxTokens } : {}),
    ...(after.model !== undefined ? { model: after.model } : {}),
    ...(after.systemPrompt !== undefined ? { systemPrompt: after.systemPrompt } : {}),
  };
  return shallowDiff(beforeFlat, afterFlat);
}

/** Passthrough wrapper that records stream outcome (success/failure/early-return). */
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
    // Consumer-driven generator closure (return() called without exhaustion).
    // This is normal control flow — the caller consumed enough events and stopped.
    // Record as success, not failure, to avoid poisoning telemetry.
    if (!recorded) {
      onComplete("success");
    }
  }
}
