/**
 * RLM middleware factory — gates the downstream chain on input size and
 * splits oversized requests into segmented `next()` calls.
 *
 * `wrapModelCall` does the segment/dispatch/reassemble dance.
 * `wrapModelStream` fails closed when the request exceeds the budget:
 * streaming reassembly across multiple downstream streams is out of
 * scope, but silently letting oversized streamed requests bypass the
 * gate would be a contract break (engines with native `modelStream`
 * skip call-only middleware on the streaming path).
 */

import type {
  CapabilityFragment,
  KoiMiddleware,
  ModelChunk,
  ModelContentBlock,
  ModelHandler,
  ModelRequest,
  ModelResponse,
  ModelStopReason,
  ModelStreamHandler,
  TokenEstimator,
  TurnContext,
} from "@koi/core";
import { HEURISTIC_ESTIMATOR } from "@koi/token-estimator";
import { validateRlmConfig } from "./config.js";
import { reassembleResponses } from "./reassemble.js";
import { segmentRequest } from "./segment.js";
import type { RlmConfig, RlmEvent } from "./types.js";
import {
  DEFAULT_MAX_CHUNK_CHARS,
  DEFAULT_MAX_INPUT_TOKENS,
  DEFAULT_PRIORITY,
  DEFAULT_SEGMENT_SEPARATOR,
} from "./types.js";

interface ResolvedConfig {
  readonly maxInputTokens: number;
  readonly maxChunkChars: number;
  readonly estimator: TokenEstimator;
  readonly priority: number;
  readonly onEvent: ((event: RlmEvent) => void) | undefined;
  readonly acknowledgeSegmentLocalContract: boolean;
  readonly segmentSeparator: string;
  readonly trustMetadataRole: boolean;
}

function resolveConfig(config: RlmConfig): ResolvedConfig {
  return {
    maxInputTokens: config.maxInputTokens ?? DEFAULT_MAX_INPUT_TOKENS,
    maxChunkChars: config.maxChunkChars ?? DEFAULT_MAX_CHUNK_CHARS,
    estimator: config.estimator ?? HEURISTIC_ESTIMATOR,
    priority: config.priority ?? DEFAULT_PRIORITY,
    onEvent: config.onEvent,
    acknowledgeSegmentLocalContract: config.acknowledgeSegmentLocalContract ?? false,
    segmentSeparator: config.segmentSeparator ?? DEFAULT_SEGMENT_SEPARATOR,
    trustMetadataRole: config.trustMetadataRole ?? false,
  };
}

function emit(cfg: ResolvedConfig, event: RlmEvent): void {
  if (cfg.onEvent === undefined) return;
  // Wrap both sync throws and rejected promises so an async observer
  // implementation cannot surface an unhandled rejection at the runtime
  // level. The contract is fail-open observability — telemetry must
  // never affect middleware behavior, sync or async.
  try {
    const result = cfg.onEvent(event) as unknown;
    if (result instanceof Promise) {
      result.catch(() => {
        // observer must not affect middleware behavior (async path)
      });
    }
  } catch {
    // observer must not affect middleware behavior (sync path)
  }
}

/**
 * Estimate the full footprint a provider sees for `request` — messages plus
 * the system prompt and tool descriptors injected by L1. Token estimators
 * only know about messages, so we add `estimateText` for the system prompt
 * and a JSON serialization of the tools list.
 */
async function estimateRequestTokens(cfg: ResolvedConfig, request: ModelRequest): Promise<number> {
  const messageTokens = await cfg.estimator.estimateMessages(request.messages, request.model);
  let extra = 0; // let: accumulate sidecar token contributions
  if (request.systemPrompt !== undefined && request.systemPrompt.length > 0) {
    extra += await cfg.estimator.estimateText(request.systemPrompt, request.model);
  }
  if (request.tools !== undefined && request.tools.length > 0) {
    extra += await cfg.estimator.estimateText(JSON.stringify(request.tools), request.model);
  }
  return messageTokens + extra;
}

/**
 * Stop reasons that signal an incomplete or non-text response. Concatenating
 * those into a synthetic "complete" answer would mask truncation, tool-use
 * intent, errors, or hook blocks.
 */
const ABORTING_STOP_REASONS: ReadonlySet<ModelStopReason> = new Set<ModelStopReason>([
  "length",
  "tool_use",
  "error",
  "hook_blocked",
]);

/**
 * Some adapters return tool calls in `richContent` without setting
 * `stopReason`. Treat richContent tool-call blocks as authoritative so RLM
 * never reassembles a response that would replay segment-local tool calls.
 */
function hasToolCallBlock(response: ModelResponse): boolean {
  if (response.richContent === undefined) return false;
  for (const block of response.richContent) {
    if (block.kind === "tool_call") return true;
  }
  return false;
}

/**
 * Synthesize a terminal abort response for a cancelled segmented run
 * without invoking the downstream handler. Mirrors the metadata shape
 * `consumeStream` builds for streamed aborts so observability /
 * delivery paths see a single contract.
 */
function buildAbortResponse(seg: ModelRequest): ModelResponse {
  const signal = seg.signal;
  const isTimeout =
    signal !== undefined &&
    signal.reason instanceof DOMException &&
    signal.reason.name === "TimeoutError";
  return {
    content: "",
    model: seg.model ?? "",
    stopReason: "error",
    metadata: {
      rlmStreamError: isTimeout ? "Stream timed out" : "Stream cancelled",
      interrupted: true,
      terminatedBy: isTimeout ? "activity-timeout" : "abort",
    },
  };
}

async function dispatchSegmented(
  cfg: ResolvedConfig,
  segments: readonly ModelRequest[],
  next: ModelHandler,
): Promise<ModelResponse> {
  const responses: ModelResponse[] = [];
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (seg === undefined) continue;
    // Pre-dispatch abort guard. Without this, a cancellation that
    // arrives after segment k completes still pays for segments
    // k+1..N because not every downstream handler short-circuits
    // synchronously on an already-aborted signal. RLM owns the
    // segmentation loop, so RLM owns the abort-between-chunks check.
    if (seg.signal?.aborted === true) {
      throw createSegmentAbortError({
        index: i,
        total: segments.length,
        response: buildAbortResponse(seg),
        toolCallAborts: false,
        kind: "call",
        completedSegments: [...responses],
      });
    }
    const response = await next(seg);
    const stopAborts =
      response.stopReason !== undefined && ABORTING_STOP_REASONS.has(response.stopReason);
    const toolCallAborts = hasToolCallBlock(response);
    if (stopAborts || toolCallAborts) {
      throw createSegmentAbortError({
        index: i,
        total: segments.length,
        response,
        toolCallAborts,
        kind: "call",
        completedSegments: [...responses],
      });
    }
    responses.push(response);
    emit(cfg, { kind: "segment-completed", index: i, count: segments.length });
  }
  return reassembleResponses(responses, cfg.segmentSeparator);
}

/**
 * Error thrown by RLM when a segmented call/stream cannot be safely
 * reassembled because a segment returned a non-success terminal state.
 *
 * The original segment response is attached as `cause` plus exposed on
 * a typed `segmentResponse` field so observability / retry / delivery
 * paths can recover the structured failure metadata (interrupted /
 * terminatedBy / errorCode / retryable / retryAfterMs) the
 * synthesized terminal response carries. A bare `throw new Error(...)`
 * with only a string would discard those signals on exactly the
 * oversized path RLM is meant to virtualize.
 */
export class SegmentAbortError extends Error {
  override readonly name = "SegmentAbortError";
  readonly segmentIndex: number;
  readonly segmentCount: number;
  readonly segmentResponse: ModelResponse;
  readonly toolCallAborts: boolean;
  /**
   * Per-segment responses for chunks 0..segmentIndex-1 that completed
   * successfully before the failing chunk. Callers can use these to
   * resume from `segmentIndex` instead of re-dispatching the whole
   * oversized turn, and observability can attribute already-paid usage
   * even when the run aborts mid-flight.
   */
  readonly completedSegments: readonly ModelResponse[];
  /**
   * Aggregated usage across `completedSegments`. Surfaces token cost
   * already paid for the partial run; absent when no completed segment
   * carried usage.
   */
  readonly completedUsage:
    | {
        readonly inputTokens: number;
        readonly outputTokens: number;
        readonly cacheReadTokens?: number;
        readonly cacheWriteTokens?: number;
      }
    | undefined;
  constructor(args: {
    readonly message: string;
    readonly index: number;
    readonly total: number;
    readonly response: ModelResponse;
    readonly toolCallAborts: boolean;
    readonly completedSegments: readonly ModelResponse[];
  }) {
    super(args.message, { cause: args.response });
    this.segmentIndex = args.index;
    this.segmentCount = args.total;
    this.segmentResponse = args.response;
    this.toolCallAborts = args.toolCallAborts;
    this.completedSegments = args.completedSegments;
    this.completedUsage = aggregateCompletedUsage(args.completedSegments);
  }
}

function aggregateCompletedUsage(completed: readonly ModelResponse[]):
  | {
      readonly inputTokens: number;
      readonly outputTokens: number;
      readonly cacheReadTokens?: number;
      readonly cacheWriteTokens?: number;
    }
  | undefined {
  let any = false;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let hasCacheRead = false;
  let hasCacheWrite = false;
  for (const r of completed) {
    if (r.usage === undefined) continue;
    any = true;
    inputTokens += r.usage.inputTokens;
    outputTokens += r.usage.outputTokens;
    if (r.usage.cacheReadTokens !== undefined) {
      cacheReadTokens += r.usage.cacheReadTokens;
      hasCacheRead = true;
    }
    if (r.usage.cacheWriteTokens !== undefined) {
      cacheWriteTokens += r.usage.cacheWriteTokens;
      hasCacheWrite = true;
    }
  }
  if (!any) return undefined;
  return {
    inputTokens,
    outputTokens,
    ...(hasCacheRead ? { cacheReadTokens } : {}),
    ...(hasCacheWrite ? { cacheWriteTokens } : {}),
  };
}

function createSegmentAbortError(args: {
  readonly index: number;
  readonly total: number;
  readonly response: ModelResponse;
  readonly toolCallAborts: boolean;
  readonly kind: "call" | "stream";
  readonly completedSegments: readonly ModelResponse[];
}): SegmentAbortError {
  const reason = args.toolCallAborts
    ? `tool_call richContent (stopReason=${String(args.response.stopReason)})`
    : `stopReason=${String(args.response.stopReason)}`;
  const meta = (args.response.metadata ?? {}) as Record<string, unknown>;
  const detail: string[] = [];
  if (meta.interrupted === true) {
    detail.push(`interrupted=true terminatedBy=${String(meta.terminatedBy ?? "unknown")}`);
  }
  if (meta.errorCode !== undefined) detail.push(`code=${String(meta.errorCode)}`);
  if (meta.retryable !== undefined) detail.push(`retryable=${String(meta.retryable)}`);
  if (meta.retryAfterMs !== undefined) detail.push(`retryAfterMs=${String(meta.retryAfterMs)}`);
  if (typeof meta.rlmStreamError === "string") detail.push(`message=${meta.rlmStreamError}`);
  const detailStr = detail.length > 0 ? ` [${detail.join(" ")}]` : "";
  const phase = args.kind === "stream" ? "streaming segment" : "segment";
  return new SegmentAbortError({
    message: `RLM ${phase} ${String(args.index + 1)}/${String(args.total)} returned ${reason} (model=${args.response.model})${detailStr}. Concatenating an incomplete or tool-use segment would mask the failure; aborting.`,
    index: args.index,
    total: args.total,
    response: args.response,
    completedSegments: args.completedSegments,
    toolCallAborts: args.toolCallAborts,
  });
}

async function rlmWrapModelCall(
  cfg: ResolvedConfig,
  _ctx: TurnContext,
  request: ModelRequest,
  next: ModelHandler,
): Promise<ModelResponse> {
  const tokens = await estimateRequestTokens(cfg, request);
  if (tokens <= cfg.maxInputTokens) {
    emit(cfg, { kind: "passthrough", tokens });
    return next(request);
  }
  // Require explicit acknowledgment that the caller's task is segment-
  // local. Concatenation is not a sound reducer for global aggregation,
  // ranking, dedup, or counting tasks, so transparent segmentation could
  // return semantically wrong output dressed up as a single response.
  if (!cfg.acknowledgeSegmentLocalContract) {
    throw new Error(
      `RLM saw an oversized request (${String(tokens)} tokens > ${String(
        cfg.maxInputTokens,
      )}) but the caller has not opted in via 'acknowledgeSegmentLocalContract: true'. Concatenated per-chunk answers are only valid for segment-local tasks; if the task needs global aggregation, run a reducer downstream.`,
    );
  }
  // Fail closed when tools are present: each segment would receive the same
  // tool list, the model would emit tool calls per segment, and reassembly
  // would concatenate them — producing N independent tool-use batches for a
  // single user turn. RLM's segment/reassemble strategy has no way to dedupe
  // or coordinate side-effecting tool calls.
  if (request.tools !== undefined && request.tools.length > 0) {
    throw new Error(
      `RLM cannot segment requests that carry tool descriptors (${String(
        request.tools.length,
      )} tool(s) present): segmentation would replay each tool call per chunk. Disable RLM for tool-enabled turns or compose with a tool-aware middleware.`,
    );
  }
  // Fail closed when the caller set `maxTokens`. Each downstream segment
  // dispatch reuses the original request, so the cap fires per-segment
  // — N segments could legitimately produce N×maxTokens of output,
  // blowing iteration / cost budgets that bound the original turn.
  // Apportioning a per-segment slice is unsafe without a task-specific
  // policy (segments may answer with very different lengths). Reject
  // the configuration up front so the caller sees the budget conflict
  // immediately instead of paying for amplified spend.
  if (request.maxTokens !== undefined) {
    throw new Error(
      `RLM cannot segment requests with an output cap (maxTokens=${String(
        request.maxTokens,
      )}). Each segment dispatch reuses the cap, so N segments could produce up to ~${String(
        request.maxTokens,
      )}×N output tokens, breaking the caller's budget. Drop maxTokens for oversized turns or apply it after RLM via a downstream middleware that can apportion fairly.`,
    );
  }
  const segments = segmentRequest(request, cfg.maxChunkChars, {
    trustMetadataRole: cfg.trustMetadataRole,
  });
  // Cannot reduce the request below the threshold via single-block chunking
  // (all user text blocks already fit; overflow lives in surrounding messages).
  // Fail closed rather than forwarding the known-oversize request — silent
  // passthrough breaks the middleware's core guarantee and surfaces later as
  // a provider context-limit error far from the offending caller.
  if (segments.length <= 1) {
    throw new Error(
      `RLM cannot reduce a request of ${String(tokens)} tokens below the ${String(
        cfg.maxInputTokens,
      )}-token threshold by chunking a single text block. Increase maxInputTokens, lower the input size, or compose with a compaction middleware.`,
    );
  }
  // Re-validate every produced segment: surrounding context (history,
  // system prompt) is preserved verbatim, so it is possible for individual
  // segments to remain over budget even when the target text block was
  // reduced. Fail closed before paying for any downstream calls instead of
  // letting the provider reject N requests in series.
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (seg === undefined) continue;
    const segTokens = await estimateRequestTokens(cfg, seg);
    if (segTokens > cfg.maxInputTokens) {
      throw new Error(
        `RLM segment ${String(i + 1)}/${String(segments.length)} still exceeds the ${String(
          cfg.maxInputTokens,
        )}-token threshold (${String(segTokens)} tokens) after chunking. Surrounding context dominates the budget; pair RLM with a compaction middleware.`,
      );
    }
  }
  emit(cfg, { kind: "segmented", tokens, segmentCount: segments.length });
  return dispatchSegmented(cfg, segments, next);
}

/**
 * Create the RLM middleware. Throws if `config` is malformed; consult
 * {@link validateRlmConfig} to validate without throwing.
 */
export function createRlmMiddleware(config?: RlmConfig): KoiMiddleware {
  const result = validateRlmConfig(config);
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  const cfg = resolveConfig(result.value);
  const capability: CapabilityFragment = {
    label: "rlm",
    description: `RLM: oversized requests segmented at ${String(cfg.maxInputTokens)} tokens`,
  };
  return {
    name: "koi:rlm",
    priority: cfg.priority,
    phase: "intercept",
    wrapModelCall: (ctx, req, next) => rlmWrapModelCall(cfg, ctx, req, next),
    wrapModelStream: (ctx, req, next) => rlmWrapModelStream(cfg, ctx, req, next),
    describeCapabilities: () => capability,
  } satisfies KoiMiddleware;
}

/**
 * Drive the downstream stream to completion and recover the final
 * `ModelResponse`. Adapters always emit a `done` chunk at the end of a
 * stream; we trust it as the authoritative response.
 *
 * Some upstream stream implementations report token usage via incremental
 * `usage` chunks rather than (or in addition to) `done.response.usage`.
 * Accumulate those chunks and merge into the returned response so
 * downstream cost / budget enforcement does not undercount oversized
 * streamed turns. When `done.response.usage` is already set, prefer it as
 * authoritative; otherwise fall back to the streamed totals.
 */
/**
 * Drive the downstream stream and fold it into a single `ModelResponse`.
 *
 * Three correctness properties:
 *
 *   1. **Abort-aware.** Each `iterator.next()` races against
 *      `request.signal` so a stalled provider cannot hang an oversized
 *      streamed turn past the runtime's timeout / cancel signal. On
 *      abort we synthesize a terminal response from what we accumulated.
 *
 *   2. **Error chunks are first-class.** `ModelChunk.error` is a
 *      structured stream outcome — provider failures, rate limits, or
 *      hook-blocks — that the normal query-engine consumer folds into a
 *      terminal response with `stopReason: "error"`. RLM mirrors that
 *      contract so segment reassembly's stopReason guard decides whether
 *      to abort, instead of swallowing partial text + usage in an
 *      exception.
 *
 *   3. **Empty terminal content backfilled.** Some providers stream the
 *      real text in `text_delta` chunks and emit `done.response.content:
 *      ""`. Without backfill, oversized streamed turns reassemble to
 *      empty answers.
 */
interface ConsumedSegment {
  readonly response: ModelResponse;
  readonly thinkingText: string;
}

async function consumeStream(
  request: ModelRequest,
  next: ModelStreamHandler,
): Promise<ConsumedSegment> {
  let streamedInput = 0; // let: per-segment usage accumulator
  let streamedOutput = 0; // let: per-segment usage accumulator
  let sawUsage = false; // let: did the stream emit any `usage` chunks
  let streamedText = ""; // let: accumulate text_delta in case done.response.content is empty
  let streamedThinking = ""; // let: accumulate thinking_delta so the segmented
  // stream can re-emit it; oversized turns are exactly the cases where
  // reasoning chronology is most needed, and silently dropping it
  // would diverge the RLM streaming contract from the normal one.
  let model = ""; // let: best-effort model id from done or fallback
  let responseId: string | undefined;
  // Pre-dispatch abort guard. Opening a downstream stream with an
  // already-aborted signal would still send the request to the provider
  // (or downstream handlers that check abort lazily) and incur paid
  // traffic. Short-circuit before invoking `next`.
  if (request.signal?.aborted === true) {
    const isTimeout =
      request.signal.reason instanceof DOMException &&
      request.signal.reason.name === "TimeoutError";
    return {
      response: {
        content: "",
        model: request.model ?? "",
        stopReason: "error",
        metadata: {
          rlmStreamError: isTimeout ? "Stream timed out" : "Stream cancelled",
          interrupted: true,
          terminatedBy: isTimeout ? "activity-timeout" : "abort",
        },
      },
      thinkingText: "",
    };
  }
  const iterator = next(request)[Symbol.asyncIterator]();
  const signal = request.signal;
  const abortPromise: Promise<{ readonly aborted: true }> | undefined =
    signal === undefined
      ? undefined
      : new Promise((resolve) => {
          if (signal.aborted) {
            resolve({ aborted: true });
            return;
          }
          signal.addEventListener("abort", () => resolve({ aborted: true }), { once: true });
        });

  function buildTerminalResponse(
    overrides: {
      readonly stopReason?: ModelStopReason;
      readonly errorMessage?: string;
      readonly interrupted?: boolean;
      readonly terminatedBy?: "abort" | "activity-timeout";
      readonly errorCode?: string;
      readonly retryable?: boolean;
      readonly retryAfterMs?: number;
    } = {},
  ): ConsumedSegment {
    const usage = sawUsage
      ? { inputTokens: streamedInput, outputTokens: streamedOutput }
      : undefined;
    const baseStopReason: ModelStopReason | undefined =
      overrides.stopReason ?? (overrides.errorMessage !== undefined ? "error" : undefined);
    // Preserve structured failure metadata so the outer dispatch guard
    // (and any caller observing the synthetic terminal response) can
    // distinguish caller aborts from real provider failures, and so
    // retryable/backoff signals from upstream `error` chunks are not
    // lost on the oversized streaming path.
    const meta: Record<string, unknown> = {};
    if (overrides.errorMessage !== undefined) meta.rlmStreamError = overrides.errorMessage;
    if (overrides.interrupted === true) meta.interrupted = true;
    if (overrides.terminatedBy !== undefined) meta.terminatedBy = overrides.terminatedBy;
    if (overrides.errorCode !== undefined) meta.errorCode = overrides.errorCode;
    if (overrides.retryable !== undefined) meta.retryable = overrides.retryable;
    if (overrides.retryAfterMs !== undefined) meta.retryAfterMs = overrides.retryAfterMs;
    const hasMeta = Object.keys(meta).length > 0;
    return {
      response: {
        content: streamedText,
        model,
        ...(usage !== undefined ? { usage } : {}),
        ...(baseStopReason !== undefined ? { stopReason: baseStopReason } : {}),
        ...(responseId !== undefined ? { responseId } : {}),
        ...(hasMeta ? { metadata: meta } : {}),
      },
      thinkingText: streamedThinking,
    };
  }

  // Track whether we exited cleanly via the `done` chunk. Any other
  // exit (abort, error chunk, streamed tool_call, missing terminal) is
  // an early termination that must release the upstream iterator so
  // the base stream handler runs its own resume/cleanup logic. Without
  // this, the agent can stay in `wait(model_stream)` and leak provider
  // / network resources on exactly the failure paths RLM is supposed
  // to hard-stop.
  let exitedOnDone = false; // let: gates iterator cleanup in finally
  try {
    while (true) {
      const nextPromise = iterator.next();
      const settled =
        abortPromise === undefined
          ? await nextPromise
          : await Promise.race([nextPromise, abortPromise]);
      if ("aborted" in settled && settled.aborted === true) {
        // Distinguish caller cancel from activity-timeout via the
        // signal's reason (matches the query-engine consumer's
        // mapping). Both terminate the segmented run, but the
        // metadata flag lets delivery / observability paths key off
        // the right semantic.
        const isTimeout =
          signal !== undefined &&
          signal.reason instanceof DOMException &&
          signal.reason.name === "TimeoutError";
        return buildTerminalResponse({
          stopReason: "error",
          errorMessage: isTimeout ? "Stream timed out" : "Stream cancelled",
          interrupted: true,
          // Match the runtime's existing sentinel — `delivery-policy.ts`
          // and `runtime-factory.ts` key timeout handling off the literal
          // `"activity-timeout"`. Inventing a different value would
          // skip those recovery branches on oversized streamed turns.
          terminatedBy: isTimeout ? "activity-timeout" : "abort",
        });
      }
      const result = settled as IteratorResult<ModelChunk>;
      if (result.done === true) {
        return buildTerminalResponse({ errorMessage: "stream ended without 'done' chunk" });
      }
      const chunk = result.value;
      if (chunk.kind === "text_delta") {
        streamedText += chunk.delta;
        continue;
      }
      if (chunk.kind === "thinking_delta") {
        // Reasoning text must survive segmented streaming. The outer
        // generator re-emits accumulated thinking per segment so the
        // engine, TUI, and observability path see the same first-class
        // thinking_delta events they would on a non-segmented turn.
        streamedThinking += chunk.delta;
        continue;
      }
      if (chunk.kind === "usage") {
        streamedInput += chunk.inputTokens;
        streamedOutput += chunk.outputTokens;
        sawUsage = true;
        continue;
      }
      if (chunk.kind === "done") {
        const response = chunk.response;
        model = response.model;
        if (response.responseId !== undefined) responseId = response.responseId;
        // Three-step backfill order: prefer the explicit content
        // field; fall back to accumulated text_delta chunks; finally
        // synthesize from richContent text blocks. Adapters that emit
        // final text only in richContent (no top-level content, no
        // streamed deltas) would otherwise reassemble to an empty
        // answer.
        let content = response.content;
        if (content.length === 0) content = streamedText;
        if (content.length === 0 && response.richContent !== undefined) {
          let richText = "";
          for (const block of response.richContent) {
            if (block.kind === "text") richText += block.text;
          }
          content = richText;
        }
        const usage =
          response.usage ??
          (sawUsage ? { inputTokens: streamedInput, outputTokens: streamedOutput } : undefined);
        exitedOnDone = true; // generator already finished — no return() needed
        return {
          response: {
            ...response,
            content,
            ...(usage !== undefined ? { usage } : {}),
          },
          thinkingText: streamedThinking,
        };
      }
      if (
        chunk.kind === "tool_call_start" ||
        chunk.kind === "tool_call_delta" ||
        chunk.kind === "tool_call_end"
      ) {
        // Streamed tool calls are a structured fail-closed signal even
        // if the terminal `done.response` does not echo them in
        // richContent / stopReason. Synthesize a terminal response
        // carrying stopReason='tool_use' + a richContent tool_call
        // placeholder so dispatchSegmented's stopReason guard +
        // hasToolCallBlock check both abort reassembly.
        const toolCallBlock: ModelContentBlock = {
          kind: "tool_call",
          id: chunk.kind === "tool_call_start" ? chunk.callId : chunk.callId,
          name: chunk.kind === "tool_call_start" ? chunk.toolName : "unknown",
          arguments: {},
        };
        const usage = sawUsage
          ? { inputTokens: streamedInput, outputTokens: streamedOutput }
          : undefined;
        return {
          response: {
            content: streamedText,
            model,
            ...(usage !== undefined ? { usage } : {}),
            stopReason: "tool_use",
            ...(responseId !== undefined ? { responseId } : {}),
            richContent: [toolCallBlock],
          },
          thinkingText: streamedThinking,
        };
      }
      if (chunk.kind === "error") {
        // Structured stream failure: fold what we have into a
        // terminal response with `stopReason: "error"`, preserving
        // provider/hook metadata (code/retryable/retryAfterMs).
        // Treat error.usage as authoritative terminal usage and
        // *overwrite* the running totals (matches
        // packages/lib/query-engine/src/consume-stream.ts). Providers
        // can emit incremental `usage` deltas before the failure and
        // then repeat the final cumulative numbers on the error
        // chunk; adding both would double-count the tokens already
        // billed for the segment.
        if (chunk.usage !== undefined) {
          streamedInput = chunk.usage.inputTokens;
          streamedOutput = chunk.usage.outputTokens;
          sawUsage = true;
        }
        return buildTerminalResponse({
          stopReason: "error",
          errorMessage: chunk.message,
          ...(chunk.code !== undefined ? { errorCode: chunk.code } : {}),
          ...(chunk.retryable !== undefined ? { retryable: chunk.retryable } : {}),
          ...(chunk.retryAfterMs !== undefined ? { retryAfterMs: chunk.retryAfterMs } : {}),
        });
      }
      // Unknown chunk kinds are not informative for reassembly.
      // Skip without losing forward progress.
    }
  } finally {
    // Best-effort iterator release on every non-`done` exit. Fire-and-
    // forget so a generator stuck in a forever-await cannot hang the
    // cleanup itself; ignore any rejection.
    if (!exitedOnDone) {
      iterator.return?.().catch(() => {
        // closing a hung iterator is best-effort
      });
    }
  }
}

/**
 * Streaming path: query-engine prefers `modelStream` whenever an adapter
 * exposes it, so failing closed here would turn every oversized turn —
 * the exact traffic RLM is meant to handle — into a user-visible error.
 *
 * Strategy: small requests stream through unchanged. Oversized requests
 * run the same segment/dispatch path as `wrapModelCall`, but each
 * segment's downstream call is the underlying *stream* handler whose
 * terminal `done` chunk carries the segment's `ModelResponse`. The
 * reassembled response is then re-emitted as a synthetic stream — a
 * single `text_delta` of the merged content, an aggregate `usage` chunk,
 * and `done` carrying the full reassembled response — so consumers
 * downstream of the engine see one coherent answer instead of N
 * interleaved partial streams.
 *
 * We do NOT proxy per-chunk text deltas through to the consumer because
 * that would replay tool-call/thinking blocks from intermediate segments
 * before reassembly's safety guards have a chance to abort.
 */
async function* rlmWrapModelStream(
  cfg: ResolvedConfig,
  _ctx: TurnContext,
  request: ModelRequest,
  next: ModelStreamHandler,
): AsyncIterable<ModelChunk> {
  const tokens = await estimateRequestTokens(cfg, request);
  if (tokens <= cfg.maxInputTokens) {
    emit(cfg, { kind: "passthrough", tokens });
    yield* next(request);
    return;
  }
  if (!cfg.acknowledgeSegmentLocalContract) {
    throw new Error(
      `RLM saw an oversized streaming request (${String(tokens)} tokens > ${String(
        cfg.maxInputTokens,
      )}) but the caller has not opted in via 'acknowledgeSegmentLocalContract: true'. Concatenated per-chunk answers are only valid for segment-local tasks.`,
    );
  }
  if (request.tools !== undefined && request.tools.length > 0) {
    throw new Error(
      `RLM cannot segment streaming requests that carry tool descriptors (${String(
        request.tools.length,
      )} tool(s) present): segmentation would replay each tool call per chunk.`,
    );
  }
  // Same maxTokens budget guard as the non-streaming path. See
  // wrapModelCall for the rationale.
  if (request.maxTokens !== undefined) {
    throw new Error(
      `RLM cannot segment streaming requests with an output cap (maxTokens=${String(
        request.maxTokens,
      )}). Each segment dispatch reuses the cap, breaking the caller's budget by a factor of N. Drop maxTokens for oversized turns or apply it after RLM.`,
    );
  }
  const segments = segmentRequest(request, cfg.maxChunkChars, {
    trustMetadataRole: cfg.trustMetadataRole,
  });
  if (segments.length <= 1) {
    throw new Error(
      `RLM cannot reduce a streaming request of ${String(tokens)} tokens below the ${String(
        cfg.maxInputTokens,
      )}-token threshold by chunking a single text block.`,
    );
  }
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (seg === undefined) continue;
    const segTokens = await estimateRequestTokens(cfg, seg);
    if (segTokens > cfg.maxInputTokens) {
      throw new Error(
        `RLM streaming segment ${String(i + 1)}/${String(segments.length)} still exceeds the ${String(
          cfg.maxInputTokens,
        )}-token threshold (${String(segTokens)} tokens) after chunking.`,
      );
    }
  }
  emit(cfg, { kind: "segmented", tokens, segmentCount: segments.length });

  const responses: ModelResponse[] = [];
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (seg === undefined) continue;
    // Pre-dispatch abort guard for the streaming path — see the
    // matching guard in dispatchSegmented. Opening a fresh downstream
    // stream after a late abort would leak an extra paid provider
    // request on every cancelled oversized turn.
    if (seg.signal?.aborted === true) {
      throw createSegmentAbortError({
        index: i,
        total: segments.length,
        response: buildAbortResponse(seg),
        toolCallAborts: false,
        kind: "stream",
        completedSegments: [...responses],
      });
    }
    const consumed = await consumeStream(seg, next);
    const { response, thinkingText } = consumed;
    // Re-emit per-segment thinking before the next segment opens so the
    // engine, TUI, and event-trace see thinking_delta in segment order
    // alongside the eventual aggregate text. Holding it until after
    // reassembly would invert the visible chronology.
    if (thinkingText.length > 0) {
      yield { kind: "thinking_delta", delta: thinkingText };
    }
    const stopAborts =
      response.stopReason !== undefined && ABORTING_STOP_REASONS.has(response.stopReason);
    const toolCallAborts = hasToolCallBlock(response);
    if (stopAborts || toolCallAborts) {
      throw createSegmentAbortError({
        index: i,
        total: segments.length,
        response,
        toolCallAborts,
        kind: "stream",
        completedSegments: [...responses],
      });
    }
    responses.push(response);
    emit(cfg, { kind: "segment-completed", index: i, count: segments.length });
  }
  const merged = reassembleResponses(responses, cfg.segmentSeparator);
  if (merged.content.length > 0) {
    yield { kind: "text_delta", delta: merged.content };
  }
  if (merged.usage !== undefined) {
    yield {
      kind: "usage",
      inputTokens: merged.usage.inputTokens,
      outputTokens: merged.usage.outputTokens,
    };
  }
  yield { kind: "done", response: merged };
}
