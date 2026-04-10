/**
 * Target execution and capability-matching logic.
 *
 * Extracted from router.ts to keep router.ts under 200 lines.
 * Handles: per-target request execution with retry, capability checks,
 * and metrics recording.
 */

import type { ModelRequest, ModelResponse } from "@koi/core";
import type { RetryConfig } from "@koi/errors";
import { withRetry } from "@koi/errors";
import type { ResolvedTargetConfig } from "./config.js";
import type { LatencyTracker } from "./latency-tracker.js";
import type { ProviderAdapter } from "./provider-adapter.js";

export interface RouteExecutionContext {
  readonly adapters: ReadonlyMap<string, ProviderAdapter>;
  readonly targetConfigById: ReadonlyMap<string, ResolvedTargetConfig>;
  readonly latencyTrackers: ReadonlyMap<string, LatencyTracker>;
  readonly requestsByTarget: Record<string, number>;
  readonly failuresByTarget: Record<string, number>;
  readonly retryConfig: RetryConfig;
  readonly clock: () => number;
}

/**
 * Executes a model request against a single target, with retry and metrics tracking.
 *
 * Throws on failure (error propagates to withFallback for CB recording).
 */
export async function executeForTarget(
  targetId: string,
  request: ModelRequest,
  ctx: RouteExecutionContext,
): Promise<ModelResponse> {
  const targetConfig = ctx.targetConfigById.get(targetId);
  if (targetConfig === undefined) {
    throw {
      code: "NOT_FOUND",
      message: `Target config not found: ${targetId}`,
      retryable: false,
    };
  }

  const adapter = ctx.adapters.get(targetConfig.provider);
  if (adapter === undefined) {
    throw {
      code: "NOT_FOUND",
      message: `Adapter not found for provider: ${targetConfig.provider}`,
      retryable: false,
    };
  }

  ctx.requestsByTarget[targetId] = (ctx.requestsByTarget[targetId] ?? 0) + 1;

  const modelRequest: ModelRequest = { ...request, model: targetConfig.model };
  const startMs = ctx.clock();

  try {
    const response = await withRetry(
      () => adapter.complete(modelRequest),
      ctx.retryConfig,
      ctx.clock,
    );
    ctx.latencyTrackers.get(targetId)?.record(ctx.clock() - startMs);
    return response;
  } catch (error: unknown) {
    ctx.failuresByTarget[targetId] = (ctx.failuresByTarget[targetId] ?? 0) + 1;
    throw error;
  }
}

/**
 * Returns true if the target can serve the given request's required capabilities.
 *
 * Fail-open: if the target declares no capabilities, assume it supports everything.
 * This prevents false negatives on adapters that haven't declared caps yet.
 */
export function targetSupportsRequest(
  targetConfig: ResolvedTargetConfig,
  request: ModelRequest,
): boolean {
  const caps = targetConfig.capabilities;
  if (caps === undefined) return true;

  // Vision: if any message block is an image, target must support vision
  const needsVision = request.messages.some((m) => m.content.some((b) => b.kind === "image"));
  if (needsVision && caps.vision === false) return false;

  return true;
}
