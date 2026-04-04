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
          // Snapshot before middleware for value-based delta detection.
          // Deep-clone input via structured clone so nested in-place mutations are detectable.
          const beforeInputCopy =
            captureDeltas === true ? (structuredClone(request.input) as JsonObject) : undefined;
          const beforeInputHash = captureDeltas === true ? safeSnapshot(request.input) : undefined;
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
            // let: mutable — computed in try block for fail-open safety
            let deltaMeta: JsonObject | undefined;
            try {
              if (
                captureDeltas === true &&
                capturedInput !== undefined &&
                beforeInputHash !== undefined &&
                beforeInputCopy !== undefined &&
                beforeInputHash !== safeSnapshot(capturedInput)
              ) {
                deltaMeta = shallowDiff(beforeInputCopy, capturedInput) ?? undefined;
              }
            } catch {
              // Fail-open: tracing never breaks the request path
            }
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

/** Compare two values by value (JSON serialization for non-primitives). */
function valuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (typeof a === "object" && a !== null && b !== null) {
    return JSON.stringify(a) === JSON.stringify(b);
  }
  return false;
}

/**
 * Diff two objects by value. Returns `{ changed, added, removed }` or
 * undefined if objects are identical by value.
 */
function shallowDiff(before: JsonObject, after: JsonObject): JsonObject | undefined {
  const changed: Record<string, { readonly from: unknown; readonly to: unknown }> = {};
  const added: Record<string, unknown> = {};
  const removed: string[] = [];

  for (const key of Object.keys(before)) {
    if (!(key in after)) {
      removed.push(key);
    } else if (!valuesEqual(before[key], after[key])) {
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

/** Safe JSON snapshot for value-based comparison. Never truncated — uses hash for large payloads. */
function safeSnapshot(obj: unknown): string {
  return JSON.stringify(obj);
}

/** Snapshot model request fields for value-based delta detection. */
interface ModelRequestSnapshot {
  readonly scalars: JsonObject;
  readonly messagesHash: string;
  readonly messageCount: number;
  readonly metadataSnapshot: JsonObject;
  readonly toolNames: readonly string[];
  readonly toolsHash: string;
}

function snapshotModelRequest(req: ModelRequest): ModelRequestSnapshot {
  const tools = req.tools ?? [];
  return {
    scalars: {
      temperature: req.temperature,
      maxTokens: req.maxTokens,
      model: req.model,
      systemPrompt: req.systemPrompt,
    } as JsonObject,
    messagesHash: safeSnapshot(req.messages),
    messageCount: req.messages.length,
    metadataSnapshot: structuredClone(req.metadata ?? {}) as JsonObject,
    toolNames: tools.map((t) => t.name),
    toolsHash: safeSnapshot(tools),
  };
}

/**
 * Compute request delta by comparing a pre-snapshot against the post-middleware request.
 * Uses value-based comparison to detect in-place mutations.
 * Fail-open: returns undefined on any error so tracing never breaks the request path.
 */
function computeRequestDeltaFromSnapshot(
  before: ModelRequestSnapshot,
  after: ModelRequest,
): JsonObject | undefined {
  try {
    const afterSnapshot = snapshotModelRequest(after);

    const scalarsChanged = safeSnapshot(before.scalars) !== safeSnapshot(afterSnapshot.scalars);
    const messagesChanged = before.messagesHash !== afterSnapshot.messagesHash;
    const metadataChanged =
      safeSnapshot(before.metadataSnapshot) !== safeSnapshot(afterSnapshot.metadataSnapshot);
    const toolsChanged = before.toolsHash !== afterSnapshot.toolsHash;

    if (!scalarsChanged && !messagesChanged && !metadataChanged && !toolsChanged) {
      return undefined;
    }

    const result: Record<string, unknown> = {};

    if (scalarsChanged) {
      const delta = shallowDiff(before.scalars, afterSnapshot.scalars);
      if (delta !== undefined) Object.assign(result, delta);
    }

    if (messagesChanged) {
      result.messages = {
        messagesBefore: before.messageCount,
        messagesAfter: afterSnapshot.messageCount,
        contentChanged: before.messageCount === afterSnapshot.messageCount,
      };
    }

    if (metadataChanged) {
      const delta = shallowDiff(before.metadataSnapshot, afterSnapshot.metadataSnapshot);
      if (delta !== undefined) result.metadata = delta;
    }

    if (toolsChanged) {
      const removed = before.toolNames.filter((n) => !afterSnapshot.toolNames.includes(n));
      const added = afterSnapshot.toolNames.filter((n) => !before.toolNames.includes(n));
      result.tools = {
        ...(removed.length > 0 ? { removed } : {}),
        ...(added.length > 0 ? { added } : {}),
        toolsBefore: before.toolNames.length,
        toolsAfter: afterSnapshot.toolNames.length,
      };
    }

    return Object.keys(result).length > 0 ? (result as JsonObject) : undefined;
  } catch {
    // Fail-open: tracing must never break the request path
    return undefined;
  }
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
