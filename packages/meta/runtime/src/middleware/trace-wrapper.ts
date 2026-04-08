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
 *   - structured decision metadata (via ctx.reportDecision)
 *
 * Performance: spans are buffered per-turn and flushed once in onAfterTurn
 * (one store.append per turn instead of N individual calls).
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
  SessionContext,
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

/** Middleware names excluded from trace wrapping (trajectory recorders themselves). */
const TRACE_EXCLUDED: ReadonlySet<string> = new Set(["event-trace"]);

/**
 * Wraps a middleware to record every hook invocation as an ATIF trajectory step.
 * The wrapped middleware behaves identically — this is pure observation.
 *
 * Spans are buffered in-turn and flushed once in onAfterTurn for efficiency.
 *
 * Apply to all middleware before passing to createKoi() or recomposeChains():
 *   const traced = middleware.map(mw => wrapMiddlewareWithTrace(mw, config));
 */
export function wrapMiddlewareWithTrace(
  mw: KoiMiddleware,
  config: TraceWrapperConfig,
): KoiMiddleware {
  // Don't trace the trajectory recorder itself — circular and noisy
  if (TRACE_EXCLUDED.has(mw.name)) return mw;
  const { store, docId, captureDeltas } = config;
  const clock = config.clock ?? Date.now;

  // Issue 7: monotonic span counter — per wrapper instance, reset on each session
  let spanIndex = 0;

  // Issue 13: buffer spans in-turn, flush once in onAfterTurn
  const pendingSteps: RichTrajectoryStep[] = [];

  function recordStep(
    base: Omit<RichTrajectoryStep, "stepIndex" | "metadata">,
    metadata: JsonObject,
  ): void {
    pendingSteps.push({ ...base, stepIndex: spanIndex++, metadata });
  }

  async function flushSteps(): Promise<void> {
    if (pendingSteps.length === 0) return;
    const toFlush = pendingSteps.splice(0);
    await store.append(docId, toFlush).catch(() => {});
  }

  // Issue 5: shared metadata builder — eliminates 5× duplication of the base shape
  function buildSpanMeta(hook: string, nextCalled: boolean, extras?: JsonObject): JsonObject {
    return {
      type: "middleware_span",
      middlewareName: mw.name,
      hook,
      phase: mw.phase ?? "resolve",
      priority: mw.priority ?? 500,
      nextCalled,
      ...(extras ?? {}),
    };
  }

  // Issue 5: shared base step builder
  function buildBaseStep(
    outcome: "success" | "failure",
    start: number,
    requestText: string,
    responseText?: string,
    errorText?: string,
  ): Omit<RichTrajectoryStep, "stepIndex" | "metadata"> {
    return {
      timestamp: clock(),
      source: "system",
      kind: "model_call",
      identifier: `middleware:${mw.name}`,
      outcome,
      durationMs: performance.now() - start,
      request: { text: requestText },
      ...(responseText !== undefined ? { response: { text: responseText } } : {}),
      ...(errorText !== undefined ? { error: { text: errorText } } : {}),
    };
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
          // let: mutable — set in try block
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

          // Issue 8: per-call traceCtx — injects reportDecision callback.
          // MUST be constructed inside the hook invocation (not outer closure)
          // to ensure concurrent calls get independent decisions arrays.
          const decisions: JsonObject[] = [];
          const traceCtx: TurnContext = {
            ...ctx,
            reportDecision: (d: JsonObject) => {
              decisions.push(d);
            },
          };

          try {
            const response = await hook(traceCtx, request, trackedNext);
            const deltaMeta =
              captureDeltas === true && afterSnapshot !== undefined && beforeSnapshot !== undefined
                ? computeRequestDeltaFromSnapshots(beforeSnapshot, afterSnapshot)
                : undefined;
            recordStep(
              buildBaseStep("success", start, requestPreview, response.content.slice(0, 500)),
              buildSpanMeta("wrapModelCall", nextCalled, {
                ...(deltaMeta !== undefined ? { requestDelta: deltaMeta } : {}),
                // Issue 12: decisions preserved in both success and failure paths
                ...(decisions.length > 0 ? { decisions } : {}),
              }),
            );
            return response;
          } catch (error: unknown) {
            const errorText = error instanceof Error ? error.message : String(error);
            recordStep(
              buildBaseStep("failure", start, requestPreview, undefined, errorText),
              buildSpanMeta("wrapModelCall", nextCalled, {
                // Issue 12: decisions accumulated before throw are preserved
                ...(decisions.length > 0 ? { decisions } : {}),
              }),
            );
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

          // Issue 8: per-call traceCtx with independent decisions array
          const decisions: JsonObject[] = [];
          const traceCtx: TurnContext = {
            ...ctx,
            reportDecision: (d: JsonObject) => {
              decisions.push(d);
            },
          };

          try {
            const response = await hook(traceCtx, request, trackedNext);
            const outputStr =
              typeof response.output === "string"
                ? response.output
                : safeStringify(response.output, 500);
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
            recordStep(
              buildBaseStep("success", start, requestPreview, outputStr.slice(0, 500)),
              buildSpanMeta("wrapToolCall", nextCalled, {
                ...(deltaMeta !== undefined ? { inputDelta: deltaMeta } : {}),
                ...(decisions.length > 0 ? { decisions } : {}),
              }),
            );
            return response;
          } catch (error: unknown) {
            const errorText = error instanceof Error ? error.message : String(error);
            recordStep(
              buildBaseStep("failure", start, requestPreview, undefined, errorText),
              buildSpanMeta("wrapToolCall", nextCalled, {
                ...(decisions.length > 0 ? { decisions } : {}),
              }),
            );
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

          // Issue 8: per-call traceCtx — decisions collected mid-stream via closure
          const decisions: JsonObject[] = [];
          const traceCtx: TurnContext = {
            ...ctx,
            reportDecision: (d: JsonObject) => {
              decisions.push(d);
            },
          };

          // Wrap the stream to record on completion, tracking success/failure/abort
          const inner = hook(traceCtx, request, trackedStreamNext);
          return wrapStreamForTrace(inner, (outcome, errorMessage) => {
            const deltaMeta =
              captureDeltas === true &&
              afterStreamSnapshot !== undefined &&
              beforeStreamSnapshot !== undefined
                ? computeRequestDeltaFromSnapshots(beforeStreamSnapshot, afterStreamSnapshot)
                : undefined;
            recordStep(
              {
                timestamp: clock(),
                source: "system",
                kind: "model_call",
                identifier: `middleware:${mw.name}`,
                outcome,
                durationMs: performance.now() - start,
                request: { text: requestPreview },
                ...(errorMessage !== undefined ? { error: { text: errorMessage } } : {}),
              },
              buildSpanMeta("wrapModelStream", true, {
                ...(errorMessage !== undefined ? { error: errorMessage } : {}),
                ...(deltaMeta !== undefined ? { requestDelta: deltaMeta } : {}),
                ...(decisions.length > 0 ? { decisions } : {}),
              }),
            );
          });
        }
      : undefined;

  return {
    ...mw,
    ...(wrappedModelCall !== undefined ? { wrapModelCall: wrappedModelCall } : {}),
    ...(wrappedToolCall !== undefined ? { wrapToolCall: wrappedToolCall } : {}),
    ...(wrappedModelStream !== undefined ? { wrapModelStream: wrappedModelStream } : {}),
    // Issue 13: flush buffered spans once per turn (single store.append vs N individual calls)
    onAfterTurn: async (ctx: TurnContext): Promise<void> => {
      if (mw.onAfterTurn !== undefined) await mw.onAfterTurn(ctx);
      await flushSteps();
    },
    // Safety net: flush any spans buffered by onSessionStart/onBeforeTurn/onBeforeStop
    // that don't have an onAfterTurn counterpart (e.g., session start failures).
    onSessionEnd: async (ctx: SessionContext): Promise<void> => {
      if (mw.onSessionEnd !== undefined) await mw.onSessionEnd(ctx);
      await flushSteps();
      // Reset counter for next session
      spanIndex = 0;
    },
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

/**
 * Extract readable text from a ModelRequest's messages.
 * Issue 14: early-exit accumulator stops iterating once 500 chars are collected.
 */
function extractModelRequestText(request: ModelRequest): string {
  let buf = "";
  outer: for (const msg of request.messages) {
    for (const block of msg.content) {
      if (block.kind !== "text") continue;
      buf += block.text;
      if (buf.length >= 500) {
        buf = buf.slice(0, 500);
        break outer;
      }
    }
  }
  return buf.length < 500 ? buf : `${buf}…`;
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
  };
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
    },
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
