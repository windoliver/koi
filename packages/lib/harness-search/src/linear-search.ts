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
    attemptTimeoutMs = DEFAULT_SEARCH_CONFIG.attemptTimeoutMs,
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

    const evalOutcome = await withDeadline(
      (sig) => evaluate(currentCode, initialDescriptor, sig),
      signal,
      attemptTimeoutMs,
    );
    if (!evalOutcome.ok) {
      stopReason =
        evalOutcome.kind === "aborted"
          ? "aborted"
          : evalOutcome.kind === "timeout"
            ? "eval_timeout"
            : "eval_failed";
      break;
    }
    const evalResult: EvalResult = evalOutcome.value;

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

    // Replace best on strict rate improvement OR on a tie that brings more
    // evidence (higher sampleCount) — otherwise an early under-sampled hit
    // at successRate=1.0 sticks around even after a later, fully-sampled
    // tie satisfies the convergence gate, and `best` would not match the
    // node that triggered the convergence stop.
    const beatsRate = evalResult.successRate > bestSuccessRate;
    const tiesRateWithMoreEvidence =
      bestNode !== null &&
      evalResult.successRate === bestSuccessRate &&
      evalResult.sampleCount > bestNode.evalSamples;
    if (beatsRate || tiesRateWithMoreEvidence) {
      bestSuccessRate = evalResult.successRate;
      bestNode = node;
      if (beatsRate) consecutiveNoImprovement = 0;
      else consecutiveNoImprovement++;
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
      const refineOutcome = await withDeadline(
        (sig) => refine(currentCode, evalResult.failures, iteration + 1, maxIterations, sig),
        signal,
        attemptTimeoutMs,
      );
      if (!refineOutcome.ok) {
        stopReason =
          refineOutcome.kind === "aborted"
            ? "aborted"
            : refineOutcome.kind === "timeout"
              ? "refine_timeout"
              : "refine_failed";
        break;
      }
      const parsed = parseRefinementOutput(refineOutcome.value);
      if (parsed === null) {
        // Unparseable / empty refinement is a partial-failure mode the
        // caller must be able to distinguish from "candidate unchanged" —
        // silently reusing the prior code burns budget and hides broken
        // refiners. Surface it as refine_failed.
        stopReason = "refine_failed";
        break;
      }
      currentCode = parsed;
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
    converged:
      finalBest.successRate !== null &&
      finalBest.successRate >= convergenceThreshold &&
      finalBest.evalSamples >= minEvalSamples,
  };
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted ?? false;
}

type DeadlineOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly kind: "timeout" | "aborted" | "error" };

/**
 * Race a callback against a per-attempt deadline AND the external
 * cancellation signal. Returns a tagged outcome; the caller decides
 * which `StopReason` to surface. The deadline is enforced *here* — not
 * left to the callback to honor — so a non-cooperative adapter cannot
 * hang the bounded search loop. The per-attempt AbortSignal is forwarded
 * to the callback so cooperative adapters can release in-flight work
 * promptly.
 */
async function withDeadline<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  parentSignal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<DeadlineOutcome<T>> {
  const controller = new AbortController();
  const onParentAbort = (): void => controller.abort();
  if (parentSignal !== undefined) {
    if (parentSignal.aborted) controller.abort();
    else parentSignal.addEventListener("abort", onParentAbort, { once: true });
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const timeoutPromise: Promise<DeadlineOutcome<T>> = Number.isFinite(timeoutMs)
    ? new Promise((resolve) => {
        timer = setTimeout(() => {
          timedOut = true;
          controller.abort();
          resolve({ ok: false, kind: "timeout" });
        }, timeoutMs);
      })
    : new Promise(() => {
        // Never resolves — Infinity disables the deadline; callback wins.
      });

  try {
    const callbackPromise = fn(controller.signal).then(
      (value): DeadlineOutcome<T> => ({ ok: true, value }),
      (): DeadlineOutcome<T> => {
        if (timedOut) return { ok: false, kind: "timeout" };
        if (isAborted(parentSignal)) return { ok: false, kind: "aborted" };
        return { ok: false, kind: "error" };
      },
    );
    return await Promise.race([callbackPromise, timeoutPromise]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (parentSignal !== undefined) parentSignal.removeEventListener("abort", onParentAbort);
  }
}
