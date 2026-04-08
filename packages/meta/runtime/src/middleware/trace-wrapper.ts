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
  /** Injectable clock for deterministic timestamps. Default: Date.now. */
  readonly clock?: () => number;
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
  const clock = config.clock ?? Date.now;

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
          // Snapshot before middleware for value-based delta detection.
          // Fail-open: if snapshotting throws (circular ref, BigInt), skip deltas.
          // let: mutable ��� set in try block
          let beforeSnapshot: ModelRequestSnapshot | undefined;
          if (captureDeltas === true) {
            try {
              beforeSnapshot = snapshotModelRequest(request);
            } catch {
              // Non-cloneable request — delta capture skipped
            }
          }
          // Snapshot the forwarded request at the moment next() is invoked
          // (not after middleware returns) to avoid post-next mutations.
          let afterSnapshot: ModelRequestSnapshot | undefined;
          const trackedNext: ModelHandler = async (req) => {
            nextCalled = true;
            if (captureDeltas === true && beforeSnapshot !== undefined) {
              try {
                afterSnapshot = snapshotModelRequest(req);
              } catch {
                // Non-cloneable — skip delta
              }
            }
            return next(req);
          };

          try {
            const response = await hook(ctx, request, trackedNext);
            const deltaMeta =
              captureDeltas === true && afterSnapshot !== undefined && beforeSnapshot !== undefined
                ? computeRequestDeltaFromSnapshots(beforeSnapshot, afterSnapshot)
                : undefined;
            // ModelCall spans: omit request/response — those are on the
            // model step. MW spans only capture the middleware's own behavior.
            const modelDecision = nextCalled ? "allowed" : "blocked";
            recordStep({
              stepIndex: 0,
              timestamp: clock(),
              source: "system",
              kind: "model_call",
              identifier: `middleware:${mw.name}`,
              outcome: "success",
              durationMs: performance.now() - start,
              response: { text: modelDecision },
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
              timestamp: clock(),
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

          const requestPreview = `${request.toolId}(${safeStringify(request.input, 300)})`;
          const start = performance.now();
          // let: mutable — tracks next() call and captures modified request
          let nextCalled = false;
          // Snapshot before middleware for value-based delta detection.
          // Fail-open: if cloning throws (circular ref, BigInt), skip deltas.
          // let: mutable — set in try block
          let beforeInputCopy: JsonObject | undefined;
          let beforeInputHash: string | undefined;
          if (captureDeltas === true) {
            try {
              beforeInputCopy = structuredClone(request.input) as JsonObject;
              beforeInputHash = safeSnapshot(request.input);
            } catch {
              // Non-cloneable input — delta capture skipped
            }
          }
          // Snapshot forwarded input at next() boundary to avoid post-handoff mutations
          let afterInputCopy: JsonObject | undefined;
          let afterInputHash: string | undefined;
          const trackedNext: ToolHandler = async (req) => {
            nextCalled = true;
            if (captureDeltas === true && beforeInputHash !== undefined) {
              try {
                afterInputCopy = structuredClone(req.input) as JsonObject;
                afterInputHash = safeSnapshot(req.input);
              } catch {
                // Non-cloneable — skip delta
              }
            }
            return next(req);
          };

          try {
            const response = await hook(ctx, request, trackedNext);
            // let: mutable — computed in try block for fail-open safety
            let deltaMeta: JsonObject | undefined;
            try {
              if (
                captureDeltas === true &&
                afterInputCopy !== undefined &&
                afterInputHash !== undefined &&
                beforeInputHash !== undefined &&
                beforeInputCopy !== undefined &&
                beforeInputHash !== afterInputHash
              ) {
                deltaMeta = shallowDiff(beforeInputCopy, afterInputCopy) ?? undefined;
              }
            } catch {
              // Fail-open: tracing never breaks the request path
            }
            // Tool spans: request shows tool+args (concise), response shows
            // MW decision — not the full tool output (that's on the tool step).
            const decision = nextCalled ? "allowed" : "blocked";
            recordStep({
              stepIndex: 0,
              timestamp: clock(),
              source: "system",
              kind: "model_call",
              identifier: `middleware:${mw.name}`,
              outcome: "success",
              durationMs: performance.now() - start,
              request: { text: requestPreview },
              response: { text: decision },
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
              timestamp: clock(),
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

          const start = performance.now();

          // Track modified request for delta capture in stream path.
          // Fail-open: if snapshotting throws, skip deltas.
          // let: mutable — set in try block
          let beforeStreamSnapshot: ModelRequestSnapshot | undefined;
          if (captureDeltas === true) {
            try {
              beforeStreamSnapshot = snapshotModelRequest(request);
            } catch {
              // Non-cloneable request — delta capture skipped
            }
          }
          let afterStreamSnapshot: ModelRequestSnapshot | undefined;
          const trackedStreamNext: ModelStreamHandler = (req) => {
            if (captureDeltas === true && beforeStreamSnapshot !== undefined) {
              try {
                afterStreamSnapshot = snapshotModelRequest(req);
              } catch {
                // Non-cloneable — skip delta
              }
            }
            return next(req);
          };

          // Wrap the stream to record on completion, tracking success/failure/abort
          const inner = hook(ctx, request, trackedStreamNext);
          return wrapStreamForTrace(inner, (outcome, errorMessage, _responseText) => {
            const deltaMeta =
              captureDeltas === true &&
              afterStreamSnapshot !== undefined &&
              beforeStreamSnapshot !== undefined
                ? computeRequestDeltaFromSnapshots(beforeStreamSnapshot, afterStreamSnapshot)
                : undefined;
            // ModelStream spans: omit request/response — those are on the model
            // step itself. MW spans only capture the middleware's own behavior
            // (duration, outcome, nextCalled, deltas).
            recordStep({
              stepIndex: 0,
              timestamp: clock(),
              source: "system",
              kind: "model_call",
              identifier: `middleware:${mw.name}`,
              outcome,
              durationMs: performance.now() - start,
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

/** Safe JSON.stringify that never throws. Returns fallback on circular/BigInt/etc. */
function safeStringify(value: unknown, maxLen: number): string {
  try {
    const s = JSON.stringify(value);
    return s.length <= maxLen ? s : `${s.slice(0, maxLen)}…`;
  } catch {
    return "[unserializable]";
  }
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

/** Describe a value's type and size for structural summaries. */
function describeValue(val: unknown): string {
  if (val === null || val === undefined) return "null";
  if (Array.isArray(val)) return `array(${val.length})`;
  if (typeof val === "object")
    return `object(${Object.keys(val as Record<string, unknown>).length})`;
  if (typeof val === "string") return `string(${(val as string).length})`;
  return typeof val;
}

/**
 * Structural diff of two objects. Records changed/added/removed field names
 * with type summaries, never raw values — safe for sensitive payloads.
 */
function shallowDiff(before: JsonObject, after: JsonObject): JsonObject | undefined {
  const changed: Record<string, { readonly fromType: string; readonly toType: string }> = {};
  const added: Record<string, string> = {};
  const removed: string[] = [];

  for (const key of Object.keys(before)) {
    if (!(key in after)) {
      removed.push(key);
    } else if (!valuesEqual(before[key], after[key])) {
      changed[key] = { fromType: describeValue(before[key]), toType: describeValue(after[key]) };
    }
  }
  for (const key of Object.keys(after)) {
    if (!(key in before)) {
      added[key] = describeValue(after[key]);
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
 * Compute request delta by comparing two snapshots (before/after middleware).
 * Both snapshots are taken at the boundary — immune to post-next mutations.
 * Fail-open: returns undefined on any error so tracing never breaks the request path.
 */
function computeRequestDeltaFromSnapshots(
  before: ModelRequestSnapshot,
  after: ModelRequestSnapshot,
): JsonObject | undefined {
  try {
    const scalarsChanged = safeSnapshot(before.scalars) !== safeSnapshot(after.scalars);
    const messagesChanged = before.messagesHash !== after.messagesHash;
    const metadataChanged =
      safeSnapshot(before.metadataSnapshot) !== safeSnapshot(after.metadataSnapshot);
    const toolsChanged = before.toolsHash !== after.toolsHash;

    if (!scalarsChanged && !messagesChanged && !metadataChanged && !toolsChanged) {
      return undefined;
    }

    const result: Record<string, unknown> = {};

    if (scalarsChanged) {
      const delta = shallowDiff(before.scalars, after.scalars);
      if (delta !== undefined) Object.assign(result, delta);
    }

    if (messagesChanged) {
      result.messages = {
        messagesBefore: before.messageCount,
        messagesAfter: after.messageCount,
        contentChanged: before.messageCount === after.messageCount,
      };
    }

    if (metadataChanged) {
      const delta = shallowDiff(before.metadataSnapshot, after.metadataSnapshot);
      if (delta !== undefined) result.metadata = delta;
    }

    if (toolsChanged) {
      const removed = before.toolNames.filter((n) => !after.toolNames.includes(n));
      const added = after.toolNames.filter((n) => !before.toolNames.includes(n));
      result.tools = {
        ...(removed.length > 0 ? { removed } : {}),
        ...(added.length > 0 ? { added } : {}),
        toolsBefore: before.toolNames.length,
        toolsAfter: after.toolNames.length,
      };
    }

    return Object.keys(result).length > 0 ? (result as JsonObject) : undefined;
  } catch {
    // Fail-open: tracing must never break the request path
    return undefined;
  }
}

/** Passthrough wrapper that records stream outcome and accumulates response text. */
async function* wrapStreamForTrace(
  inner: AsyncIterable<ModelChunk>,
  onComplete: (
    outcome: "success" | "failure",
    errorMessage?: string,
    responseText?: string,
  ) => void,
): AsyncIterable<ModelChunk> {
  // let: mutable — tracks whether onComplete was already called
  let recorded = false;
  // Accumulate text_delta chunks for response capture (capped at 500 chars)
  const textParts: string[] = [];
  // let: mutable — running length to avoid repeated join for cap check
  let textLen = 0;
  const TEXT_CAP = 500;
  try {
    for await (const chunk of inner) {
      if (chunk.kind === "text_delta" && textLen < TEXT_CAP) {
        textParts.push(chunk.delta);
        textLen += chunk.delta.length;
      }
      yield chunk;
    }
    recorded = true;
    const responseText = textParts.join("").slice(0, TEXT_CAP);
    onComplete("success", undefined, responseText.length > 0 ? responseText : undefined);
  } catch (error: unknown) {
    recorded = true;
    const message = error instanceof Error ? error.message : String(error);
    const isAbort = error instanceof DOMException && error.name === "AbortError";
    const responseText = textParts.join("").slice(0, TEXT_CAP);
    onComplete(
      "failure",
      isAbort ? "interrupted" : message,
      responseText.length > 0 ? responseText : undefined,
    );
    throw error;
  } finally {
    if (!recorded) {
      const responseText = textParts.join("").slice(0, TEXT_CAP);
      onComplete("success", undefined, responseText.length > 0 ? responseText : undefined);
    }
  }
}
