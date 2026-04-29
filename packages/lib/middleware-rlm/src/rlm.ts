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

async function dispatchSegmented(
  cfg: ResolvedConfig,
  segments: readonly ModelRequest[],
  next: ModelHandler,
): Promise<ModelResponse> {
  const responses: ModelResponse[] = [];
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (seg === undefined) continue;
    const response = await next(seg);
    const stopAborts =
      response.stopReason !== undefined && ABORTING_STOP_REASONS.has(response.stopReason);
    const toolCallAborts = hasToolCallBlock(response);
    if (stopAborts || toolCallAborts) {
      const reason = toolCallAborts
        ? `tool_call richContent (stopReason=${String(response.stopReason)})`
        : `stopReason=${String(response.stopReason)}`;
      throw new Error(
        `RLM segment ${String(i + 1)}/${String(segments.length)} returned ${reason} (model=${response.model}). Concatenating an incomplete or tool-use segment would mask the failure; aborting.`,
      );
    }
    responses.push(response);
    emit(cfg, { kind: "segment-completed", index: i, count: segments.length });
  }
  return reassembleResponses(responses, cfg.segmentSeparator);
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
async function consumeStream(
  request: ModelRequest,
  next: ModelStreamHandler,
): Promise<ModelResponse> {
  let streamedInput = 0; // let: per-segment usage accumulator
  let streamedOutput = 0; // let: per-segment usage accumulator
  let sawUsage = false; // let: did the stream emit any `usage` chunks
  let streamedText = ""; // let: accumulate text_delta in case done.response.content is empty
  let model = ""; // let: best-effort model id from done or fallback
  let responseId: string | undefined;
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
    overrides: { readonly stopReason?: ModelStopReason; readonly errorMessage?: string } = {},
  ): ModelResponse {
    const usage = sawUsage
      ? { inputTokens: streamedInput, outputTokens: streamedOutput }
      : undefined;
    const baseStopReason: ModelStopReason | undefined =
      overrides.stopReason ?? (overrides.errorMessage !== undefined ? "error" : undefined);
    return {
      content: streamedText,
      model,
      ...(usage !== undefined ? { usage } : {}),
      ...(baseStopReason !== undefined ? { stopReason: baseStopReason } : {}),
      ...(responseId !== undefined ? { responseId } : {}),
      ...(overrides.errorMessage !== undefined
        ? { metadata: { rlmStreamError: overrides.errorMessage } }
        : {}),
    };
  }

  while (true) {
    const nextPromise = iterator.next();
    const settled =
      abortPromise === undefined
        ? await nextPromise
        : await Promise.race([nextPromise, abortPromise]);
    if ("aborted" in settled && settled.aborted === true) {
      // Abort wins. Best-effort close of the upstream iterator without
      // awaiting — a generator stuck in `await new Promise(() =>
      // undefined)` will never honor `.return()` until control returns
      // to it, so awaiting that here would just re-create the hang we
      // are escaping. Fire-and-forget release; ignore any rejection.
      iterator.return?.().catch(() => {
        // closing a hung iterator is best-effort
      });
      return buildTerminalResponse({ stopReason: "error", errorMessage: "aborted" });
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
      // Three-step backfill order: prefer the explicit content field;
      // fall back to accumulated text_delta chunks; finally synthesize
      // from richContent text blocks. Adapters that emit final text
      // only in richContent (no top-level content, no streamed deltas)
      // would otherwise reassemble to an empty answer.
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
      return {
        ...response,
        content,
        ...(usage !== undefined ? { usage } : {}),
      };
    }
    if (
      chunk.kind === "tool_call_start" ||
      chunk.kind === "tool_call_delta" ||
      chunk.kind === "tool_call_end"
    ) {
      // Streamed tool calls are a structured fail-closed signal even if
      // the terminal `done.response` does not echo them in richContent
      // / stopReason. Synthesize a terminal response carrying
      // stopReason='tool_use' + a richContent tool_call placeholder so
      // dispatchSegmented's stopReason guard + hasToolCallBlock check
      // both abort reassembly. Without this, an adapter that surfaces
      // tool use only via streaming chunks would silently bypass RLM's
      // tool-fan-out safety invariant.
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
        content: streamedText,
        model,
        ...(usage !== undefined ? { usage } : {}),
        stopReason: "tool_use",
        ...(responseId !== undefined ? { responseId } : {}),
        richContent: [toolCallBlock],
      };
    }
    if (chunk.kind === "error") {
      // Structured stream failure: fold what we have (partial text +
      // streamed usage) into a synthetic terminal response with
      // `stopReason: "error"`. The segment-level stopReason guard in
      // dispatchSegmented / wrapModelStream then aborts reassembly,
      // surfacing the failure to the caller with the accumulated state
      // intact instead of throwing a bare exception that loses it.
      if (chunk.usage !== undefined) {
        streamedInput += chunk.usage.inputTokens;
        streamedOutput += chunk.usage.outputTokens;
        sawUsage = true;
      }
      return buildTerminalResponse({
        stopReason: "error",
        errorMessage: chunk.message,
      });
    }
    // Unknown / non-text chunk kinds (tool_call_*, thinking_delta, etc.)
    // are not informative for the segmented call/reassemble path — RLM
    // already aborts on tool_call blocks via `hasToolCallBlock` once
    // done arrives. Skip them here without losing forward progress.
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
    const response = await consumeStream(seg, next);
    const stopAborts =
      response.stopReason !== undefined && ABORTING_STOP_REASONS.has(response.stopReason);
    const toolCallAborts = hasToolCallBlock(response);
    if (stopAborts || toolCallAborts) {
      const reason = toolCallAborts
        ? `tool_call richContent (stopReason=${String(response.stopReason)})`
        : `stopReason=${String(response.stopReason)}`;
      throw new Error(
        `RLM streaming segment ${String(i + 1)}/${String(segments.length)} returned ${reason} (model=${response.model}). Concatenating an incomplete or tool-use segment would mask the failure; aborting.`,
      );
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
