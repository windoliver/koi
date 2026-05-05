/**
 * Linear refinement search with Thompson-sampled continue/deploy decision.
 *
 * Strategy: keep the single best variant, refine iteratively. A 2-arm
 * bandit (continue vs deploy) decides each step whether to keep refining
 * (explore) or stop on the current best (exploit). Tree-branching is
 * deferred (#1354 follow-up); current strategy is strictly linear.
 */

import type { ToolDescriptor } from "@koi/core";
import { parseRefinementOutput } from "./parse-refinement.js";
import { createThompsonState, type ThompsonState, updateThompson } from "./thompson.js";
import {
  DEFAULT_SEARCH_CONFIG,
  type EvalResult,
  type SearchConfig,
  type SearchNode,
  type SearchResult,
  type StopReason,
} from "./types.js";

/**
 * Decide whether to continue refining or deploy.
 *
 * Models a 2-armed bandit: arm "continue" tracks improvements observed
 * from past refinements, arm "deploy" tracks the value of stopping now.
 * Returns true to continue, false to deploy.
 */
export function shouldContinue(
  continueState: ThompsonState,
  deployState: ThompsonState,
  random: () => number,
): boolean {
  const continueSample = sampleBetaApprox(continueState.alpha, continueState.beta, random);
  const deploySample = sampleBetaApprox(deployState.alpha, deployState.beta, random);
  return continueSample >= deploySample;
}

/**
 * Approximate Beta sample via mean + variance-scaled uniform noise.
 *
 * Not a true Beta variate — sufficient for binary continue/deploy
 * decisions where only relative ordering matters. For multi-arm
 * Thompson selection, use selectByThompson from @koi/variant-selection
 * which uses Marsaglia-Tsang Gamma variates.
 */
function sampleBetaApprox(alpha: number, beta: number, random: () => number): number {
  const mean = alpha / (alpha + beta);
  const variance = (alpha * beta) / ((alpha + beta) ** 2 * (alpha + beta + 1));
  const noise = (random() - 0.5) * 2 * Math.sqrt(variance) * 3;
  return Math.max(0, Math.min(1, mean + noise));
}

/**
 * Run the bounded refinement loop. Always terminates within
 * `maxIterations` iterations regardless of callback behavior.
 */
export async function linearSearch(
  initialCode: string,
  initialDescriptor: ToolDescriptor,
  config: SearchConfig,
): Promise<SearchResult> {
  const {
    refine,
    evaluate,
    maxIterations = DEFAULT_SEARCH_CONFIG.maxIterations,
    convergenceThreshold = DEFAULT_SEARCH_CONFIG.convergenceThreshold,
    minEvalSamples = DEFAULT_SEARCH_CONFIG.minEvalSamples,
    noImprovementLimit = DEFAULT_SEARCH_CONFIG.noImprovementLimit,
    clock = DEFAULT_SEARCH_CONFIG.clock,
    random = DEFAULT_SEARCH_CONFIG.random,
    signal,
  } = config;

  const history: SearchNode[] = [];
  let nodeCounter = 0;
  let currentCode = initialCode;
  let bestNode: SearchNode | null = null;
  let bestSuccessRate = -1;
  let consecutiveNoImprovement = 0;
  let continueState = createThompsonState();
  let deployState = createThompsonState();
  let stopReason: StopReason = "budget_exhausted";

  for (let iteration = 0; iteration < maxIterations; iteration++) {
    if (isAborted(signal)) {
      stopReason = "aborted";
      break;
    }

    let evalResult: EvalResult;
    try {
      evalResult = await evaluate(currentCode, initialDescriptor, signal ?? neverAbort());
    } catch (_err: unknown) {
      stopReason = isAborted(signal) ? "aborted" : "eval_failed";
      break;
    }

    const node: SearchNode = {
      id: `node-${nodeCounter++}`,
      code: currentCode,
      descriptor: initialDescriptor,
      iteration,
      successRate: evalResult.successRate,
      evalSamples: evalResult.sampleCount,
      parentId: bestNode?.id ?? null,
      createdAt: clock(),
    };
    history.push(node);

    const previousBestRate = bestSuccessRate;

    if (evalResult.successRate > bestSuccessRate) {
      bestSuccessRate = evalResult.successRate;
      bestNode = node;
      consecutiveNoImprovement = 0;
    } else {
      consecutiveNoImprovement++;
    }

    if (
      evalResult.successRate >= convergenceThreshold &&
      evalResult.sampleCount >= minEvalSamples
    ) {
      stopReason = "converged";
      break;
    }

    if (consecutiveNoImprovement >= noImprovementLimit) {
      stopReason = "no_improvement";
      break;
    }

    if (iteration > 0 && !shouldContinue(continueState, deployState, random)) {
      stopReason = "thompson_deploy";
      break;
    }

    if (iteration > 0) {
      const improved = evalResult.successRate > previousBestRate;
      continueState = updateThompson(continueState, improved);
      deployState = updateThompson(deployState, !improved);
    }

    if (iteration < maxIterations - 1 && evalResult.failures.length > 0) {
      try {
        const refinedRaw = await refine(
          currentCode,
          evalResult.failures,
          iteration + 1,
          maxIterations,
          signal ?? neverAbort(),
        );
        const parsed = parseRefinementOutput(refinedRaw);
        currentCode = parsed ?? currentCode;
      } catch (_err: unknown) {
        stopReason = isAborted(signal) ? "aborted" : "refine_failed";
        break;
      }
    }
  }

  const finalBest = bestNode ?? {
    id: `node-${nodeCounter}`,
    code: initialCode,
    descriptor: initialDescriptor,
    iteration: 0,
    successRate: null,
    evalSamples: 0,
    parentId: null,
    createdAt: clock(),
  };

  return {
    best: finalBest,
    history,
    stopReason,
    totalIterations: history.length,
    converged: bestSuccessRate >= convergenceThreshold && finalBest.evalSamples >= minEvalSamples,
  };
}

function neverAbort(): AbortSignal {
  return new AbortController().signal;
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted ?? false;
}
