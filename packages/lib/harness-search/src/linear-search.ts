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
    maxIterations: requestedMaxIterations = DEFAULT_SEARCH_CONFIG.maxIterations,
    convergenceThreshold = DEFAULT_SEARCH_CONFIG.convergenceThreshold,
    minEvalSamples = DEFAULT_SEARCH_CONFIG.minEvalSamples,
    noImprovementLimit = DEFAULT_SEARCH_CONFIG.noImprovementLimit,
    attemptTimeoutMs = DEFAULT_SEARCH_CONFIG.attemptTimeoutMs,
    adapterHonorsAbort = false,
    sanitizeFailures = DEFAULT_SEARCH_CONFIG.sanitizeFailures,
    clock = DEFAULT_SEARCH_CONFIG.clock,
    random = DEFAULT_SEARCH_CONFIG.random,
    signal,
  } = config;
  // A timed-out / aborted attempt may keep running in the background,
  // so multi-iteration search is unsafe unless callbacks are abort-aware.
  // Refuse to silently downgrade maxIterations > 1 to single-shot —
  // callers thinking they shipped refinement but getting one eval and
  // a budget_exhausted stop is the worst kind of quiet quality loss.
  // Force callers to make the choice explicit: either set
  // adapterHonorsAbort: true (asserting abort-safety, accepting the
  // background-leak cost as the price of retries) or pass
  // maxIterations: 1 (and surface the constraint in their integration).
  if (requestedMaxIterations > 1 && !adapterHonorsAbort) {
    throw new TypeError(
      "linearSearch: maxIterations > 1 requires adapterHonorsAbort: true. " +
        "Set adapterHonorsAbort: true to opt into retries (asserting both " +
        "evaluate and refine honor their AbortSignal), or pass maxIterations: 1 " +
        "for single-shot evaluation.",
    );
  }
  const maxIterations = requestedMaxIterations;

  // Fail-fast on config bugs that would otherwise silently break the
  // bounded-search guarantee (NaN slips past Number.isFinite into the
  // "Infinity disables deadline" branch in withDeadline; <= 0 produces
  // immediate timeouts; non-integer maxIterations corrupts loop bounds).
  if (!Number.isInteger(requestedMaxIterations) || requestedMaxIterations < 1) {
    throw new TypeError("linearSearch: maxIterations must be a positive integer");
  }
  if (!Number.isInteger(minEvalSamples) || minEvalSamples < 0) {
    throw new TypeError("linearSearch: minEvalSamples must be a non-negative integer");
  }
  if (!Number.isInteger(noImprovementLimit) || noImprovementLimit < 1) {
    throw new TypeError("linearSearch: noImprovementLimit must be a positive integer");
  }
  if (
    typeof attemptTimeoutMs !== "number" ||
    Number.isNaN(attemptTimeoutMs) ||
    attemptTimeoutMs <= 0
  ) {
    throw new TypeError(
      "linearSearch: attemptTimeoutMs must be a positive finite number or Infinity",
    );
  }
  if (
    typeof convergenceThreshold !== "number" ||
    !Number.isFinite(convergenceThreshold) ||
    convergenceThreshold < 0 ||
    convergenceThreshold > 1
  ) {
    throw new TypeError("linearSearch: convergenceThreshold must be a finite number in [0, 1]");
  }
  // Strict boolean check — this flag is the safety gate that decides
  // whether multiple iterations may run while a timed-out callback may
  // still be in flight. Truthy junk like "false", 1, or {} would
  // silently opt into multi-iteration mode and re-introduce overlapping
  // side effects in exactly the cases adapterHonorsAbort is meant to
  // prevent. JS truthiness is too permissive here.
  if (typeof adapterHonorsAbort !== "boolean") {
    throw new TypeError("linearSearch: adapterHonorsAbort must be a boolean");
  }

  const history: SearchNode[] = [];
  let nodeCounter = 0;
  let currentCode = initialCode;
  let bestNode: SearchNode | null = null;
  // Tracks the immediately-prior node so refinements record their actual
  // predecessor (the node whose code was refined into the current
  // candidate), not whichever historical node currently holds the best
  // score. Lineage and best-tracking are different questions.
  let lastNode: SearchNode | null = null;
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
    // Validate evaluator output as a trust-boundary input — a buggy
    // evaluator returning percentages (95), NaN, or negative counts
    // would otherwise drive false convergence and best-node selection.
    if (!isValidEvalResult(evalOutcome.value)) {
      stopReason = "eval_failed";
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
      parentId: lastNode?.id ?? null,
      createdAt: clock(),
    };
    history.push(node);
    lastNode = node;

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
      // Both strict-rate gains AND evidence accumulation on the same
      // rate are progress — the latter pushes a candidate toward the
      // minEvalSamples gate. Counting it as "no improvement" caused
      // the loop to stop with stopReason="no_improvement" before a
      // legitimate convergence could be reached (e.g. successRate=1.0
      // with sampleCount climbing 1, 2, 3, 4 toward minEvalSamples=5).
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

    // Update Thompson posteriors BEFORE the deploy decision so the
    // sampler always reflects the latest observed improvement /
    // regression. Updating after meant iteration N's evidence was
    // invisible to its own continue/deploy choice — the sampler ran
    // one step behind, sometimes deploying right after a strong gain.
    if (iteration > 0) {
      // Treat evidence accumulation on the same rate as "improved" for
      // Thompson updates, mirroring the plateau rule above. Otherwise
      // a successful but under-sampled best (e.g. rate 1.0 sampleCount 1)
      // teaches the deploy arm on every subsequent evidence-gathering
      // iteration and the sampler bails out before reaching
      // minEvalSamples.
      const improved = beatsRate || tiesRateWithMoreEvidence;
      continueState = updateThompson(continueState, improved);
      deployState = updateThompson(deployState, !improved);
    }

    if (iteration > 0 && !shouldContinue(continueState, deployState, random)) {
      stopReason = "thompson_deploy";
      break;
    }

    if (iteration < maxIterations - 1 && evalResult.failures.length > 0) {
      // Sanitize failures across the LLM trust boundary — see
      // SanitizeFailures docstring. Default redacts free-text fields;
      // callers must opt in to forwarding diagnostic detail.
      const sanitized = sanitizeFailures(evalResult.failures);
      const refineOutcome = await withDeadline(
        (sig) => refine(currentCode, sanitized, iteration + 1, maxIterations, sig),
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
 * Race a callback against THREE outcomes: callback resolution,
 * per-attempt deadline, and external cancellation. The deadline AND
 * parent abort are first-class race participants — neither relies on
 * the callback honoring its forwarded `AbortSignal`. The signal IS
 * forwarded so cooperative adapters can release in-flight work
 * promptly, but a non-cooperative adapter (ignores the signal, never
 * resolves) cannot block `withDeadline` from returning.
 */
async function withDeadline<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  parentSignal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<DeadlineOutcome<T>> {
  const controller = new AbortController();
  let onParentAbort: (() => void) | undefined;
  const abortPromise: Promise<DeadlineOutcome<T>> = new Promise((resolve) => {
    if (parentSignal === undefined) return;
    if (parentSignal.aborted) {
      controller.abort();
      resolve({ ok: false, kind: "aborted" });
      return;
    }
    onParentAbort = (): void => {
      controller.abort();
      resolve({ ok: false, kind: "aborted" });
    };
    parentSignal.addEventListener("abort", onParentAbort, { once: true });
  });

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
        // Never resolves — Infinity disables the deadline. Parent abort
        // and callback resolution still terminate the race.
      });

  try {
    // Wrap fn() in Promise.resolve().then so a synchronous throw before
    // the first await converts to a typed `error` outcome instead of
    // escaping withDeadline and rejecting the whole search. Adapters
    // that validate inputs at call entry routinely throw synchronously.
    const callbackPromise = Promise.resolve()
      .then(() => fn(controller.signal))
      .then(
        (value): DeadlineOutcome<T> => ({ ok: true, value }),
        (): DeadlineOutcome<T> => {
          if (timedOut) return { ok: false, kind: "timeout" };
          if (isAborted(parentSignal)) return { ok: false, kind: "aborted" };
          return { ok: false, kind: "error" };
        },
      );
    return await Promise.race([callbackPromise, timeoutPromise, abortPromise]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (parentSignal !== undefined && onParentAbort !== undefined) {
      parentSignal.removeEventListener("abort", onParentAbort);
    }
  }
}

/**
 * Validate evaluator output. Treats non-finite rates, out-of-range
 * rates, non-integer/negative sample counts, and non-array failures as
 * a typed eval failure instead of letting them drive convergence.
 */
function isValidEvalResult(r: EvalResult): boolean {
  return (
    typeof r.successRate === "number" &&
    Number.isFinite(r.successRate) &&
    r.successRate >= 0 &&
    r.successRate <= 1 &&
    Number.isInteger(r.sampleCount) &&
    r.sampleCount >= 0 &&
    Array.isArray(r.failures)
  );
}
