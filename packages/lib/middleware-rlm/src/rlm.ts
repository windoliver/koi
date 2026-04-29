/**
 * RLM middleware factory — gates the downstream chain on input size and
 * splits oversized requests into segmented `next()` calls.
 *
 * Streaming requests pass through unchanged. Segmentation only applies
 * to the non-streaming `wrapModelCall` path because reassembling chunked
 * deltas across multiple downstream streams adds complexity that v2
 * phase-3 explicitly defers.
 */

import type {
  CapabilityFragment,
  KoiMiddleware,
  ModelHandler,
  ModelRequest,
  ModelResponse,
  ModelStopReason,
  TokenEstimator,
  TurnContext,
} from "@koi/core";
import { HEURISTIC_ESTIMATOR } from "@koi/token-estimator";
import { validateRlmConfig } from "./config.js";
import { reassembleResponses } from "./reassemble.js";
import { segmentRequest } from "./segment.js";
import type { RlmConfig, RlmEvent } from "./types.js";
import { DEFAULT_MAX_CHUNK_CHARS, DEFAULT_MAX_INPUT_TOKENS, DEFAULT_PRIORITY } from "./types.js";

interface ResolvedConfig {
  readonly maxInputTokens: number;
  readonly maxChunkChars: number;
  readonly estimator: TokenEstimator;
  readonly priority: number;
  readonly onEvent: ((event: RlmEvent) => void) | undefined;
}

function resolveConfig(config: RlmConfig): ResolvedConfig {
  return {
    maxInputTokens: config.maxInputTokens ?? DEFAULT_MAX_INPUT_TOKENS,
    maxChunkChars: config.maxChunkChars ?? DEFAULT_MAX_CHUNK_CHARS,
    estimator: config.estimator ?? HEURISTIC_ESTIMATOR,
    priority: config.priority ?? DEFAULT_PRIORITY,
    onEvent: config.onEvent,
  };
}

function emit(cfg: ResolvedConfig, event: RlmEvent): void {
  if (cfg.onEvent === undefined) return;
  try {
    cfg.onEvent(event);
  } catch {
    // observer must not affect middleware behavior
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
    if (response.stopReason !== undefined && ABORTING_STOP_REASONS.has(response.stopReason)) {
      throw new Error(
        `RLM segment ${String(i + 1)}/${String(segments.length)} returned stopReason=${response.stopReason} (model=${response.model}). Concatenating an incomplete or tool-use segment would mask the failure; aborting.`,
      );
    }
    responses.push(response);
    emit(cfg, { kind: "segment-completed", index: i, count: segments.length });
  }
  return reassembleResponses(responses);
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
  const segments = segmentRequest(request, cfg.maxChunkChars);
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
    describeCapabilities: () => capability,
  } satisfies KoiMiddleware;
}
