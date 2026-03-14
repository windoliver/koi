/**
 * Linear refinement search with Thompson sampling for continue/deploy.
 *
 * Strategy: keep the single best variant, refine iteratively.
 * Thompson sampling decides whether to continue refining (explore) or
 * deploy the current best (exploit).
 *
 * This is the v1 strategy (Issue 8B). Tree search (branching into
 * multiple children) can be added in v2.
 */

import { createThompsonState, type ThompsonState, updateThompson } from "@koi/variant-selection";
import { parseRefinementOutput } from "./parse-refinement.js";
import type { EvalResult, SearchConfig, SearchNode, SearchResult, StopReason } from "./types.js";
import { DEFAULT_SEARCH_CONFIG } from "./types.js";

const EMPTY_OBJECT_SCHEMA = { type: "object" as const, properties: {} } as const;

/**
 * Decide whether to continue refining or deploy using Thompson sampling.
 *
 * Models the problem as a 2-armed bandit:
 * - Arm "continue": expected reward = potential improvement from refinement
 * - Arm "deploy": expected reward = current success rate
 *
 * Returns true if the search should continue (explore), false to deploy.
 */
export function shouldContinue(
  continueState: ThompsonState,
  deployState: ThompsonState,
  random: () => number,
): boolean {
  // Lightweight Beta sampling for 2-arm continue/deploy decision.
  // Uses mean + scaled noise approximation rather than full Gamma variate
  // sampling (available in @koi/variant-selection). This produces correct
  // directional behavior for the binary explore/exploit choice.
  const continueSample = sampleBetaApprox(continueState.alpha, continueState.beta, random);
  const deploySample = sampleBetaApprox(deployState.alpha, deployState.beta, random);
  return continueSample >= deploySample;
}

/**
 * Approximate Beta sampling via mean + scaled noise.
 *
 * Not a true Beta distribution sample — uses variance-scaled uniform noise
 * centered on the Beta mean. Sufficient for binary continue/deploy decisions
 * where only the relative ordering matters. For proper Beta sampling with
 * multi-arm selection, use selectByThompson from @koi/variant-selection.
 */
function sampleBetaApprox(alpha: number, beta: number, random: () => number): number {
  const mean = alpha / (alpha + beta);
  const variance = (alpha * beta) / ((alpha + beta) ** 2 * (alpha + beta + 1));
  const noise = (random() - 0.5) * 2 * Math.sqrt(variance) * 3;
  return Math.max(0, Math.min(1, mean + noise));
}

/**
 * Run linear refinement search.
 *
 * 1. Start with the initial code (iteration 0)
 * 2. Evaluate the current variant
 * 3. If converged, stop
 * 4. Use Thompson sampling to decide continue vs deploy
 * 5. If continue, refine the code and go to step 2
 * 6. If deploy or budget exhausted, stop
 */
export async function linearSearch(
  initialCode: string,
  initialDescriptor: { readonly name: string; readonly description: string },
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
  } = config;

  // let: mutable accumulator local to linearSearch, collected into readonly result
  const history: SearchNode[] = [];
  let nodeCounter = 0; // let: monotonic counter for collision-safe node IDs
  let currentCode = initialCode; // let: updated on each refinement iteration
  let bestNode: SearchNode | null = null; // let: tracks best across iterations
  let bestSuccessRate = -1; // let: tracks highest success rate seen
  let consecutiveNoImprovement = 0; // let: plateau detection counter
  let continueState = createThompsonState(); // let: Thompson posterior for explore arm
  let deployState = createThompsonState(); // let: Thompson posterior for exploit arm
  let stopReason: StopReason = "budget_exhausted"; // let: set on each exit path

  for (let iteration = 0; iteration < maxIterations; iteration++) {
    // Evaluate current variant
    let evalResult: EvalResult; // let: assigned in try block
    try {
      evalResult = await evaluate(currentCode, {
        name: initialDescriptor.name,
        description: initialDescriptor.description,
        inputSchema: EMPTY_OBJECT_SCHEMA,
      });
    } catch (_err: unknown) {
      stopReason = "eval_failed";
      break;
    }

    // Create search node
    const node: SearchNode = {
      id: `node-${nodeCounter++}`,
      code: currentCode,
      descriptor: {
        name: initialDescriptor.name,
        description: initialDescriptor.description,
        inputSchema: EMPTY_OBJECT_SCHEMA,
      },
      iteration,
      successRate: evalResult.successRate,
      evalSamples: evalResult.sampleCount,
      parentId: bestNode?.id ?? null,
      createdAt: clock(),
    };
    history.push(node);

    // Capture previous best BEFORE updating (HIGH-2 fix: avoid stale comparison)
    const previousBestRate = bestSuccessRate;

    // Track best
    if (evalResult.successRate > bestSuccessRate) {
      bestSuccessRate = evalResult.successRate;
      bestNode = node;
      consecutiveNoImprovement = 0;
    } else {
      consecutiveNoImprovement++;
    }

    // Check convergence
    if (
      evalResult.successRate >= convergenceThreshold &&
      evalResult.sampleCount >= minEvalSamples
    ) {
      stopReason = "converged";
      break;
    }

    // Check no-improvement plateau
    if (consecutiveNoImprovement >= noImprovementLimit) {
      stopReason = "no_improvement";
      break;
    }

    // Thompson sampling: should we continue or deploy?
    if (iteration > 0 && !shouldContinue(continueState, deployState, random)) {
      stopReason = "thompson_deploy";
      break;
    }

    // Update Thompson states based on whether refinement improved things
    if (iteration > 0) {
      const improved = evalResult.successRate > previousBestRate;
      continueState = updateThompson(continueState, improved);
      deployState = updateThompson(deployState, !improved);
    }

    // Refine for next iteration (skip on last or when no failures to learn from)
    if (iteration < maxIterations - 1 && evalResult.failures.length > 0) {
      try {
        const refinedRaw = await refine(
          currentCode,
          evalResult.failures,
          iteration + 1,
          maxIterations,
        );
        const parsed = parseRefinementOutput(refinedRaw);
        currentCode = parsed ?? currentCode; // Keep current if parse fails
      } catch (_err: unknown) {
        stopReason = "refine_failed";
        break;
      }
    }
  }

  // Ensure we have at least one node
  const finalBest = bestNode ?? {
    id: `node-${nodeCounter}`,
    code: initialCode,
    descriptor: {
      name: initialDescriptor.name,
      description: initialDescriptor.description,
      inputSchema: EMPTY_OBJECT_SCHEMA,
    },
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
