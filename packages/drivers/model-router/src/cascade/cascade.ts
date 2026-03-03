/**
 * Cascade orchestration — cheap-first escalation.
 *
 * Tries the cheapest model first, evaluates response quality,
 * and escalates to progressively more expensive models only
 * when confidence is insufficient.
 */

import type { KoiError, ModelRequest, ModelResponse, Result } from "@koi/core";
import type { CircuitBreaker } from "../circuit-breaker.js";
import type {
  CascadeAttempt,
  CascadeEvaluator,
  CascadeResult,
  CascadeTierConfig,
  ResolvedCascadeConfig,
} from "./cascade-types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Evaluates response confidence with timeout and fail-open semantics.
 * Returns 0.0 on evaluator error or timeout (fail-open → escalate).
 * Cleans up the timer to prevent leaks.
 */
async function evaluateWithTimeout(
  evaluator: CascadeEvaluator,
  request: ModelRequest,
  response: ModelResponse,
  timeoutMs: number,
): Promise<number> {
  let timerId: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      Promise.resolve(evaluator(request, response)),
      new Promise<never>((_, reject) => {
        timerId = setTimeout(
          () => reject(new Error(`Evaluator timeout after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
    return result.confidence;
  } catch (_error: unknown) {
    // Fail-open: evaluator error or timeout → confidence 0.0 → escalate
    return 0;
  } finally {
    if (timerId !== undefined) {
      clearTimeout(timerId);
    }
  }
}

function buildSuccessResult(
  response: ModelResponse,
  tierId: string,
  tierIndex: number,
  confidence: number,
  attempts: readonly CascadeAttempt[],
  totalEscalations: number,
): Result<CascadeResult, KoiError> {
  return {
    ok: true,
    value: { response, tierId, tierIndex, confidence, attempts, totalEscalations },
  };
}

// ---------------------------------------------------------------------------
// Main cascade orchestration
// ---------------------------------------------------------------------------

/**
 * Executes a cascade routing strategy across ordered tiers.
 *
 * @param tiers - Ordered list of tiers (cheapest first)
 * @param fn - Function to call a tier and get a response
 * @param evaluator - Confidence evaluator function
 * @param config - Resolved cascade configuration
 * @param circuitBreakers - Map of target ID → CircuitBreaker
 * @param request - Original model request (forwarded to evaluator)
 * @param clock - Injectable clock for timing
 */
export async function withCascade(
  tiers: readonly CascadeTierConfig[],
  fn: (tier: CascadeTierConfig) => Promise<ModelResponse>,
  evaluator: CascadeEvaluator,
  config: ResolvedCascadeConfig,
  circuitBreakers: ReadonlyMap<string, CircuitBreaker>,
  request: ModelRequest,
  clock: () => number = Date.now,
): Promise<Result<CascadeResult, KoiError>> {
  if (tiers.length === 0) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "No tiers configured for cascade routing",
        retryable: false,
      },
    };
  }

  // Filter to circuit-breaker-allowed tiers; graceful degradation if all are open
  const allowedTiers = tiers.filter((t) => {
    const cb = circuitBreakers.get(t.targetId);
    return cb === undefined || cb.isAllowed();
  });
  // Fallback: if all breakers are open, try all tiers anyway
  const candidates = allowedTiers.length > 0 ? allowedTiers : tiers;

  const attempts: CascadeAttempt[] = [];
  let totalEscalations = 0;
  let bestResponse:
    | {
        readonly response: ModelResponse;
        readonly confidence: number;
        readonly tierIndex: number;
        readonly tierId: string;
      }
    | undefined;
  let totalTokens = 0;

  for (let i = 0; i < candidates.length; i++) {
    const tier = candidates[i];
    if (!tier) continue;

    const startMs = clock();
    const cb = circuitBreakers.get(tier.targetId);

    try {
      const response = await fn(tier);
      const durationMs = clock() - startMs;

      // Track token usage for budget
      const inputTokens = response.usage?.inputTokens ?? 0;
      const outputTokens = response.usage?.outputTokens ?? 0;
      totalTokens += inputTokens + outputTokens;

      cb?.recordSuccess();

      const isLastCandidate = i === candidates.length - 1;

      // If this is the last candidate, accept without evaluation
      if (isLastCandidate) {
        attempts.push({
          tierId: tier.targetId,
          success: true,
          confidence: 1,
          escalated: false,
          durationMs,
          inputTokens,
          outputTokens,
        });
        return buildSuccessResult(response, tier.targetId, i, 1, attempts, totalEscalations);
      }

      // Check budget before evaluation
      if (config.budgetLimitTokens > 0 && totalTokens > config.budgetLimitTokens) {
        attempts.push({
          tierId: tier.targetId,
          success: true,
          confidence: 0,
          escalated: false,
          durationMs,
          inputTokens,
          outputTokens,
        });
        const best = bestResponse ?? {
          response,
          confidence: 0,
          tierIndex: i,
          tierId: tier.targetId,
        };
        return buildSuccessResult(
          best.response,
          best.tierId,
          best.tierIndex,
          best.confidence,
          attempts,
          totalEscalations,
        );
      }

      // Evaluate confidence (with timeout + fail-open)
      const confidence = await evaluateWithTimeout(
        evaluator,
        request,
        response,
        config.evaluatorTimeoutMs,
      );

      // Track best response seen
      if (!bestResponse || confidence > bestResponse.confidence) {
        bestResponse = { response, confidence, tierIndex: i, tierId: tier.targetId };
      }

      // Accept if confidence meets threshold
      if (confidence >= config.confidenceThreshold) {
        attempts.push({
          tierId: tier.targetId,
          success: true,
          confidence,
          escalated: false,
          durationMs,
          inputTokens,
          outputTokens,
        });
        return buildSuccessResult(
          response,
          tier.targetId,
          i,
          confidence,
          attempts,
          totalEscalations,
        );
      }

      // Max escalations check — return best response so far
      if (totalEscalations >= config.maxEscalations) {
        attempts.push({
          tierId: tier.targetId,
          success: true,
          confidence,
          escalated: false,
          durationMs,
          inputTokens,
          outputTokens,
        });
        const best = bestResponse;
        return buildSuccessResult(
          best.response,
          best.tierId,
          best.tierIndex,
          best.confidence,
          attempts,
          totalEscalations,
        );
      }

      // Escalate to next tier
      totalEscalations++;
      attempts.push({
        tierId: tier.targetId,
        success: true,
        confidence,
        escalated: true,
        durationMs,
        inputTokens,
        outputTokens,
      });
    } catch (error: unknown) {
      const durationMs = clock() - startMs;
      cb?.recordFailure();

      attempts.push({
        tierId: tier.targetId,
        success: false,
        escalated: i < candidates.length - 1,
        error: error instanceof Error ? error.message : String(error),
        durationMs,
      });

      if (i < candidates.length - 1) {
        totalEscalations++;
      }
    }
  }

  // All tiers exhausted — return best response if we have one
  if (bestResponse) {
    return buildSuccessResult(
      bestResponse.response,
      bestResponse.tierId,
      bestResponse.tierIndex,
      bestResponse.confidence,
      attempts,
      totalEscalations,
    );
  }

  // Complete failure
  return {
    ok: false,
    error: {
      code: "EXTERNAL",
      message: `All ${attempts.length} cascade tiers failed: ${attempts.map((a) => `${a.tierId}: ${a.error ?? "unknown"}`).join("; ")}`,
      retryable: false,
      context: {
        attempts: attempts.map((a) => ({
          tierId: a.tierId,
          error: a.error,
          durationMs: a.durationMs,
        })),
      },
    },
  };
}
