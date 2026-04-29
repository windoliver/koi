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
  const tokens = await cfg.estimator.estimateMessages(request.messages, request.model);
  if (tokens <= cfg.maxInputTokens) {
    emit(cfg, { kind: "passthrough", tokens });
    return next(request);
  }
  const segments = segmentRequest(request, cfg.maxChunkChars);
  if (segments.length <= 1) {
    emit(cfg, { kind: "passthrough", tokens });
    return next(request);
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
