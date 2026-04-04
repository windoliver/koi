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
          // Snapshot before middleware for value-based delta detection
          const beforeSnapshot = captureDeltas === true ? snapshotModelRequest(request) : undefined;
          let capturedRequest: ModelRequest | undefined;
          const trackedNext: ModelHandler = async (req) => {
            nextCalled = true;
            if (captureDeltas === true) capturedRequest = req;
            return next(req);
          };

          try {
            const response = await hook(ctx, request, trackedNext);
            const deltaMeta =
              captureDeltas === true &&
              capturedRequest !== undefined &&
              beforeSnapshot !== undefined
                ? computeRequestDeltaFromSnapshot(beforeSnapshot, capturedRequest)
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
          // Snapshot before middleware for value-based delta detection
          const beforeInputSnapshot =
            captureDeltas === true ? boundedSnapshot(request.input) : undefined;
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
              beforeInputSnapshot !== undefined &&
              beforeInputSnapshot !== boundedSnapshot(capturedInput)
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

          // Track modified request for delta capture in stream path
          const beforeStreamSnapshot =
            captureDeltas === true ? snapshotModelRequest(request) : undefined;
          let capturedStreamRequest: ModelRequest | undefined;
          const trackedStreamNext: ModelStreamHandler = (req) => {
            if (captureDeltas === true) capturedStreamRequest = req;
            return next(req);
          };

          // Wrap the stream to record on completion, tracking success/failure/abort
          const inner = hook(ctx, request, trackedStreamNext);
          return wrapStreamForTrace(inner, (outcome, errorMessage) => {
            const deltaMeta =
              captureDeltas === true &&
              capturedStreamRequest !== undefined &&
              beforeStreamSnapshot !== undefined
                ? computeRequestDeltaFromSnapshot(beforeStreamSnapshot, capturedStreamRequest)
                : undefined;
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
                ...(deltaMeta !== undefined ? { requestDelta: deltaMeta } : {}),
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

/** Bounded JSON snapshot for value-based comparison. Truncated to 4KB to cap overhead. */
function boundedSnapshot(obj: unknown): string {
  const s = JSON.stringify(obj);
  return s.length <= 4096 ? s : s.slice(0, 4096);
}

/** Snapshot model request fields for value-based delta detection. */
interface ModelRequestSnapshot {
  readonly scalars: string;
  readonly messages: string;
  readonly metadata: string;
}

function snapshotModelRequest(req: ModelRequest): ModelRequestSnapshot {
  return {
    scalars: JSON.stringify({
      temperature: req.temperature,
      maxTokens: req.maxTokens,
      model: req.model,
      systemPrompt: req.systemPrompt,
    }),
    messages: boundedSnapshot(req.messages),
    metadata: boundedSnapshot(req.metadata ?? {}),
  };
}

/**
 * Compute request delta by comparing a pre-snapshot against the post-middleware request.
 * Uses value-based comparison (JSON snapshots) to detect in-place mutations.
 */
function computeRequestDeltaFromSnapshot(
  before: ModelRequestSnapshot,
  after: ModelRequest,
): JsonObject | undefined {
  const afterSnapshot = snapshotModelRequest(after);

  const scalarsChanged = before.scalars !== afterSnapshot.scalars;
  const messagesChanged = before.messages !== afterSnapshot.messages;
  const metadataChanged = before.metadata !== afterSnapshot.metadata;

  if (!scalarsChanged && !messagesChanged && !metadataChanged) return undefined;

  const result: Record<string, unknown> = {};

  if (scalarsChanged) {
    const beforeScalars = JSON.parse(before.scalars) as JsonObject;
    const afterScalars = JSON.parse(afterSnapshot.scalars) as JsonObject;
    const delta = shallowDiff(beforeScalars, afterScalars);
    if (delta !== undefined) Object.assign(result, delta);
  }

  if (messagesChanged) {
    const beforeMessages = JSON.parse(before.messages) as readonly unknown[];
    const afterMessages = after.messages;
    result.messages = {
      messagesBefore: beforeMessages.length,
      messagesAfter: afterMessages.length,
      contentChanged: beforeMessages.length === afterMessages.length,
    };
  }

  if (metadataChanged) {
    const beforeMeta = JSON.parse(before.metadata) as JsonObject;
    const afterMeta = (after.metadata ?? {}) as JsonObject;
    const delta = shallowDiff(beforeMeta, afterMeta);
    if (delta !== undefined) result.metadata = delta;
  }

  return Object.keys(result).length > 0 ? (result as JsonObject) : undefined;
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
