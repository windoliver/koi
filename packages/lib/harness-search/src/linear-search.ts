/**
 * Linear refinement search with Thompson-sampled continue/deploy decision.
 *
 * Strategy: keep the single best variant, refine iteratively. A 2-arm
 * bandit (continue vs deploy) decides each step whether to keep refining
 * (explore) or stop on the current best (exploit). Tree-branching is
 * deferred (#1354 follow-up); current strategy is strictly linear.
 */

import type { ToolDescriptor } from "@koi/core";
import { createThompsonState, type ThompsonState, updateThompson } from "./thompson.js";
import {
  DEFAULT_SEARCH_CONFIG,
  type EvalFailure,
  type EvalResult,
  type SearchConfig,
  type SearchNode,
  type SearchResult,
  type StopReason,
  type TerminalDiagnostic,
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
    maxRefinedCodeBytes = DEFAULT_SEARCH_CONFIG.maxRefinedCodeBytes,
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
  // Default sanitizeFailures redacts every field — including toolName —
  // to fail closed across the LLM trust boundary. That is the right
  // default for ad-hoc / single-shot use, but if multi-iteration search
  // ran with the redacted default, refine() would receive no actionable
  // evidence about what broke and the loop would degenerate into
  // unguided rewrites until plateau/deploy/budget exit. Force callers
  // running refinement to make the trust decision explicit: pass
  // sanitizeFailures (a partial allowlist matching their evaluator's
  // vocabulary, or `(f) => f` for trusted in-process evaluators).
  if (requestedMaxIterations > 1 && config.sanitizeFailures === undefined) {
    throw new TypeError(
      "linearSearch: maxIterations > 1 requires an explicit sanitizeFailures. " +
        "The default redactor strips every failure field for fail-closed safety, " +
        "which leaves refine() blind. Provide a sanitizer that allowlists the " +
        "diagnostic fields your evaluator emits (e.g. matching errorCode against " +
        "a known enum, or `(f) => f` for trusted in-process evaluators), or pass " +
        "maxIterations: 1 to use the redacted default for single-shot evaluation.",
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
  // Must be a positive FINITE number — Infinity is not allowed because
  // the bounded-termination contract cannot be proven against
  // arbitrary parent signals. A present AbortSignal that never fires
  // is indistinguishable from a never-fires signal at validation time;
  // if both the callback and the signal are uncooperative, the search
  // hangs forever. Force callers to set a real deadline.
  if (
    typeof attemptTimeoutMs !== "number" ||
    !Number.isFinite(attemptTimeoutMs) ||
    attemptTimeoutMs <= 0
  ) {
    throw new TypeError(
      "linearSearch: attemptTimeoutMs must be a positive finite number (Infinity is not allowed; " +
        "the bounded-termination contract requires a real per-attempt deadline)",
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
  if (!Number.isInteger(maxRefinedCodeBytes) || maxRefinedCodeBytes < 1) {
    throw new TypeError("linearSearch: maxRefinedCodeBytes must be a positive integer");
  }
  // Snapshot + freeze the descriptor so a hostile or buggy callback
  // cannot mutate the contract mid-search. Without this, an evaluator
  // that overwrites descriptor.inputSchema or descriptor.name in-place
  // would change the contract for later iterations AND retroactively
  // appear to have used the mutated descriptor in earlier history
  // entries (every node aliases the same object). Mirrors the freeze
  // pattern in @koi/harness-synth.
  const frozenDescriptor: ToolDescriptor = freezeDescriptor(initialDescriptor);

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
  // Plateau and Thompson signals MUST compare each iteration to its
  // immediate predecessor, not to the all-time best. A refinement that
  // recovers from a regression (0.9 → 0.2 → 0.8 → 1.0) is genuine
  // progress at iter 2 even though 0.8 < 0.9; a best-keyed signal
  // would burn plateau budget and bias Thompson toward deploy on the
  // exact trajectories search is meant to ride out.
  let previousIterRate = -1;
  let previousIterSamples = -1;
  let consecutiveNoImprovement = 0;
  let continueState = createThompsonState();
  let deployState = createThompsonState();
  let stopReason: StopReason = "budget_exhausted";
  let terminalDiagnostic: TerminalDiagnostic | null = null;

  for (let iteration = 0; iteration < maxIterations; iteration++) {
    if (isAborted(signal)) {
      stopReason = "aborted";
      terminalDiagnostic = { kind: "aborted", iteration, causeClass: null };
      break;
    }

    const evalOutcome = await withDeadline(
      (sig) => evaluate(currentCode, frozenDescriptor, sig),
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
      terminalDiagnostic = {
        kind:
          evalOutcome.kind === "aborted"
            ? "aborted"
            : evalOutcome.kind === "timeout"
              ? "eval_timeout"
              : "eval_failed",
        iteration,
        causeClass: evalOutcome.kind === "error" ? (evalOutcome.causeClass ?? null) : null,
      };
      break;
    }
    // Validate evaluator output as a trust-boundary input — a buggy
    // evaluator returning percentages (95), NaN, or negative counts
    // would otherwise drive false convergence and best-node selection.
    if (!isValidEvalResult(evalOutcome.value)) {
      stopReason = "eval_failed";
      terminalDiagnostic = { kind: "eval_failed", iteration, causeClass: null };
      break;
    }
    // Coerce to plain data so every later dereference goes through
    // native objects, not the original (potentially trapping) Proxy /
    // accessor-backed object. Wrap in try/catch because a stateful
    // Proxy could pass the first validation read and throw on a later
    // access — that throw must still degrade to eval_failed, not
    // reject linearSearch().
    let evalResult: EvalResult;
    try {
      const validated: EvalResult = evalOutcome.value;
      evalResult = {
        successRate: validated.successRate,
        sampleCount: validated.sampleCount,
        failures: validated.failures.map((f) => ({
          toolName: f.toolName,
          errorCode: f.errorCode,
          errorMessage: f.errorMessage,
          parameters: { ...f.parameters },
        })),
      };
    } catch (err: unknown) {
      stopReason = "eval_failed";
      terminalDiagnostic = { kind: "eval_failed", iteration, causeClass: classifyCause(err) };
      break;
    }

    // Reject contradictory payloads (rate >= threshold AND non-empty
    // failures) BEFORE materializing a node, pushing to history, or
    // updating bestNode. Otherwise result.best could point at the very
    // candidate the loop just rejected as invalid — SearchNode does
    // not carry the failures list, so downstream callers would have
    // no way to tell the returned winner came from a poisoned eval.
    if (
      evalResult.successRate >= convergenceThreshold &&
      evalResult.sampleCount >= minEvalSamples &&
      evalResult.failures.length > 0
    ) {
      stopReason = "eval_failed";
      terminalDiagnostic = { kind: "eval_failed", iteration, causeClass: null };
      break;
    }
    // Reject the other contract hole: under-threshold rate AND no
    // failures. Refinement is gated on failures.length > 0, so this
    // shape would have the loop record history and update Thompson
    // posteriors while currentCode never changes — burning budget on
    // duplicate evaluations and exiting as budget_exhausted /
    // no_improvement / thompson_deploy when refinement was actually
    // impossible from the first response. Surface as eval_failed so
    // the caller can investigate the broken contract instead.
    if (evalResult.successRate < convergenceThreshold && evalResult.failures.length === 0) {
      stopReason = "eval_failed";
      terminalDiagnostic = { kind: "eval_failed", iteration, causeClass: null };
      break;
    }

    const node: SearchNode = {
      id: `node-${nodeCounter++}`,
      code: currentCode,
      descriptor: frozenDescriptor,
      iteration,
      successRate: evalResult.successRate,
      evalSamples: evalResult.sampleCount,
      parentId: lastNode?.id ?? null,
      createdAt: clock(),
    };
    history.push(node);
    lastNode = node;

    // Best replacement is keyed off the all-time best (correct for the
    // returned winner). Plateau / Thompson use the immediate-predecessor
    // delta below — see the previousIterRate comment up at declaration.
    const beatsBest = evalResult.successRate > bestSuccessRate;
    const tiesBestWithMoreEvidence =
      bestNode !== null &&
      evalResult.successRate === bestSuccessRate &&
      evalResult.sampleCount > bestNode.evalSamples;
    if (beatsBest || tiesBestWithMoreEvidence) {
      bestSuccessRate = evalResult.successRate;
      bestNode = node;
    }

    // Predecessor-keyed progress signal for plateau + Thompson.
    // - iter 0 has no predecessor: never count it as "no progress".
    // - rate gain over predecessor → progress.
    // - rate tie with predecessor AND more samples → progress
    //   (evidence accumulation on the same candidate).
    const beatsPredecessor = previousIterRate >= 0 && evalResult.successRate > previousIterRate;
    const tiesPredecessorWithMoreEvidence =
      previousIterRate >= 0 &&
      evalResult.successRate === previousIterRate &&
      evalResult.sampleCount > previousIterSamples;
    const progressedOverPredecessor = beatsPredecessor || tiesPredecessorWithMoreEvidence;
    if (iteration === 0 || progressedOverPredecessor) {
      consecutiveNoImprovement = 0;
    } else {
      consecutiveNoImprovement++;
    }

    if (
      evalResult.successRate >= convergenceThreshold &&
      evalResult.sampleCount >= minEvalSamples &&
      // Failure-count invariant is enforced earlier (before history
      // mutation). At this point a non-empty failures array is a
      // shape we cannot see — already exited as eval_failed.
      evalResult.failures.length === 0
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
    // regression. The "improved" signal is the same predecessor-keyed
    // delta plateau uses — a refinement that recovers from a regression
    // is genuine progress for the continue arm even when it stays
    // below the all-time best.
    if (iteration > 0) {
      continueState = updateThompson(continueState, progressedOverPredecessor);
      deployState = updateThompson(deployState, !progressedOverPredecessor);
    }

    if (iteration > 0 && !shouldContinue(continueState, deployState, random)) {
      stopReason = "thompson_deploy";
      break;
    }

    if (iteration < maxIterations - 1 && evalResult.failures.length > 0) {
      // Sanitize failures across the LLM trust boundary — see
      // SanitizeFailures docstring. Default redacts free-text fields;
      // callers must opt in to forwarding diagnostic detail. The hook
      // is caller-supplied so:
      //   (a) a buggy / hostile sanitizer that throws (cyclic objects,
      //       accessor traps, …) must surface as refine_failed, not
      //       reject linearSearch().
      //   (b) one that loops, walks an exponentially-large structure,
      //       or otherwise blocks indefinitely must NOT stall the
      //       search — bounded termination is the package's headline
      //       contract. Race the sync call against the same per-attempt
      //       deadline and parent-abort signal as evaluate/refine, so
      //       a runaway sanitizer surfaces as refine_timeout instead
      //       of hanging the loop forever.
      const sanitizeOutcome = await withDeadline(
        () => Promise.resolve(sanitizeFailures(evalResult.failures)),
        signal,
        attemptTimeoutMs,
      );
      if (!sanitizeOutcome.ok) {
        stopReason =
          sanitizeOutcome.kind === "aborted"
            ? "aborted"
            : sanitizeOutcome.kind === "timeout"
              ? "refine_timeout"
              : "refine_failed";
        terminalDiagnostic = {
          kind:
            sanitizeOutcome.kind === "aborted"
              ? "aborted"
              : sanitizeOutcome.kind === "timeout"
                ? "refine_timeout"
                : "refine_failed",
          iteration,
          causeClass:
            sanitizeOutcome.kind === "error" ? (sanitizeOutcome.causeClass ?? null) : null,
        };
        break;
      }
      const sanitized: readonly EvalFailure[] = sanitizeOutcome.value;
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
        terminalDiagnostic = {
          kind:
            refineOutcome.kind === "aborted"
              ? "aborted"
              : refineOutcome.kind === "timeout"
                ? "refine_timeout"
                : "refine_failed",
          iteration,
          causeClass: refineOutcome.kind === "error" ? (refineOutcome.causeClass ?? null) : null,
        };
        break;
      }
      // RefineCallback returns the candidate source directly. Wire-format
      // extraction (fenced code, JSON envelopes, structured tool output)
      // is the caller's responsibility — see parseRefinementOutput in
      // ./parse-refinement.ts for a fenced-code helper, or wire a
      // synth-style JSON parser inside your refine() before returning.
      // Centralizing parsing here would couple search to one wire format
      // and break callers using a different one (e.g. @koi/harness-synth).
      const next = refineOutcome.value;
      if (typeof next !== "string" || next.trim().length === 0) {
        stopReason = "refine_failed";
        terminalDiagnostic = { kind: "refine_failed", iteration, causeClass: null };
        break;
      }
      // Hard byte cap. LLM-backed refiners can echo prior code, emit
      // hallucinated scaffolding, or stream multi-hundred-KB blocks;
      // without this, every iteration would carry that payload forward
      // in `history` and into the next prompt, blowing up memory and
      // cost. Same failure mode harness-synth caps explicitly.
      if (byteLength(next) > maxRefinedCodeBytes) {
        stopReason = "refine_failed";
        terminalDiagnostic = { kind: "refine_failed", iteration, causeClass: null };
        break;
      }
      currentCode = next;
    }
    // Record THIS iteration's rate/samples so the NEXT iteration's
    // plateau + Thompson logic can compare against the immediate
    // predecessor (this iteration), not whatever historical node
    // currently holds the best score.
    previousIterRate = evalResult.successRate;
    previousIterSamples = evalResult.sampleCount;
  }

  // Do NOT synthesize a fallback node from initialCode when no
  // evaluation completed. A synthetic best is indistinguishable from a
  // real evaluated winner at the API surface, and a caller publishing
  // result.best after a transient eval_timeout / aborted exit would
  // ship unverified code. Returning null forces callers to make the
  // "did we actually evaluate anything?" check explicit.
  return {
    best: bestNode,
    history,
    stopReason,
    totalIterations: history.length,
    // Only the explicit converged exit counts. A bestNode that happens
    // to clear the rate/samples gates is NOT enough — it can still be
    // accompanied by a contradictory failures payload (eval_failed) or
    // a Thompson deploy decision the loop took before convergence
    // landed. Tying this flag to stopReason keeps the success contract
    // honest.
    converged:
      stopReason === "converged" &&
      bestNode !== null &&
      bestNode.successRate !== null &&
      bestNode.successRate >= convergenceThreshold &&
      bestNode.evalSamples >= minEvalSamples,
    terminalDiagnostic,
  };
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted ?? false;
}

/** UTF-8 byte length — the only meaningful "size" for code crossing
 * to/from a model adapter. JS string `.length` would underweight
 * non-ASCII and overweight surrogate pairs. */
function byteLength(s: string): number {
  return new TextEncoder().encode(s).byteLength;
}

/**
 * Deep-clone + Object.freeze the descriptor so callbacks cannot mutate
 * the contract mid-search. The clone is required because Object.freeze
 * is shallow — `inputSchema`, `tags`, etc. would still be mutable
 * references back into the caller's object graph.
 */
function freezeDescriptor(desc: ToolDescriptor): ToolDescriptor {
  const cloned = structuredClone(desc);
  return deepFreeze(cloned);
}

function deepFreeze<T>(o: T): T {
  if (o === null || typeof o !== "object" || Object.isFrozen(o)) return o;
  for (const key of Object.keys(o)) {
    deepFreeze((o as Record<string, unknown>)[key]);
  }
  return Object.freeze(o);
}

type DeadlineOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly kind: "timeout" | "aborted" | "error";
      /** Constructor name of the rejection (best-effort, "error" kind only). */
      readonly causeClass?: string;
    };

/**
 * Allowlist of built-in JS/Web error class names safe to surface in
 * terminal diagnostics. Anything else collapses to "Object"/"Unknown"
 * so a hostile callback cannot smuggle tenant identifiers, user data,
 * or PII through `constructor.name` (which IS caller-controlled —
 * either by extending Error or by forging an object literal whose
 * `constructor.name` is a sensitive string).
 */
const SAFE_ERROR_CLASSES: ReadonlySet<string> = new Set([
  "Error",
  "TypeError",
  "RangeError",
  "ReferenceError",
  "SyntaxError",
  "URIError",
  "EvalError",
  "AbortError",
  "AggregateError",
  "DOMException",
]);

/**
 * Best-effort extraction of an error class name for terminal
 * diagnostics. Avoids stringifying the message itself — that would
 * leak caller-controlled or sandbox-stderr content across the trust
 * boundary the package fails closed on. Only allowlisted built-in
 * error class names pass through; anything else (custom Error
 * subclasses, forged constructors, plain objects) collapses to a
 * fixed label so caller-controlled metadata cannot reach logs.
 */
function classifyCause(err: unknown): string {
  if (err === null || err === undefined) return "Unknown";
  if (typeof err === "object") {
    try {
      const name = (err as { constructor?: { name?: unknown } }).constructor?.name;
      if (typeof name === "string" && SAFE_ERROR_CLASSES.has(name)) return name;
    } catch (_e: unknown) {
      // Accessor threw — fall through.
    }
    return "Object";
  }
  return typeof err;
}

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
  // Pre-aborted parent: short-circuit before constructing controller or
  // invoking `fn`. Otherwise an already-cancelled search would still
  // launch one final callback (LLM request, verifier job, temp resource)
  // before observing the abort outcome, breaking the abort-safety
  // contract callers rely on when racing cancellation against retries.
  if (isAborted(parentSignal)) return { ok: false, kind: "aborted" };

  const controller = new AbortController();
  let onParentAbort: (() => void) | undefined;
  const abortPromise: Promise<DeadlineOutcome<T>> = new Promise((resolve) => {
    if (parentSignal === undefined) return;
    onParentAbort = (): void => {
      controller.abort();
      resolve({ ok: false, kind: "aborted" });
    };
    parentSignal.addEventListener("abort", onParentAbort, { once: true });
  });

  // timeoutMs is validated as a positive finite number at linearSearch
  // entry — no Infinity branch here.
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const timeoutPromise: Promise<DeadlineOutcome<T>> = new Promise((resolve) => {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      resolve({ ok: false, kind: "timeout" });
    }, timeoutMs);
  });

  try {
    // Wrap fn() in Promise.resolve().then so a synchronous throw before
    // the first await converts to a typed `error` outcome instead of
    // escaping withDeadline and rejecting the whole search. Adapters
    // that validate inputs at call entry routinely throw synchronously.
    const callbackPromise = Promise.resolve()
      .then(() => {
        // Re-check at microtask boundary: parent may have aborted
        // synchronously between withDeadline entry and this .then
        // running. Without this guard, fn() still executes once after
        // cancellation — leaking exactly the side effects the abort
        // contract promises to suppress.
        if (controller.signal.aborted) {
          throw new Error("aborted before invocation");
        }
        return fn(controller.signal);
      })
      .then(
        (value): DeadlineOutcome<T> => ({ ok: true, value }),
        (err: unknown): DeadlineOutcome<T> => {
          if (timedOut) return { ok: false, kind: "timeout" };
          if (isAborted(parentSignal)) return { ok: false, kind: "aborted" };
          return { ok: false, kind: "error", causeClass: classifyCause(err) };
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
/**
 * Validate evaluator output as a trust-boundary input. Wrapped in
 * try/catch because a hostile evaluator may return a Proxy or
 * accessor-backed object whose getters throw — escaped throws would
 * reject linearSearch() instead of producing the typed eval_failed
 * stop. Anything that throws or fails the shape check returns false.
 */
function isValidEvalResult(r: unknown): r is EvalResult {
  try {
    if (r === null || typeof r !== "object") return false;
    const cand = r as EvalResult;
    if (
      typeof cand.successRate !== "number" ||
      !Number.isFinite(cand.successRate) ||
      cand.successRate < 0 ||
      cand.successRate > 1 ||
      !Number.isInteger(cand.sampleCount) ||
      // sampleCount must be strictly positive: a `successRate` reported
      // against zero evidence is meaningless, would skew best-tracking
      // and Thompson updates, and could even drive false convergence
      // when callers lower minEvalSamples. Force evaluators to either
      // run at least one sample or surface no result at all (throw /
      // eval_failed), instead of letting them claim a perfect rate
      // backed by nothing.
      cand.sampleCount < 1 ||
      !Array.isArray(cand.failures)
    ) {
      return false;
    }
    // Element-level shape check — Array.isArray alone admits [null] /
    // [123] / objects missing required string fields, all of which would
    // crash in sanitizeFailures when it dereferences toolName/errorCode/
    // errorMessage and bypass the typed eval_failed stop.
    for (const f of cand.failures) {
      if (
        f === null ||
        typeof f !== "object" ||
        typeof (f as EvalFailure).toolName !== "string" ||
        typeof (f as EvalFailure).errorCode !== "string" ||
        typeof (f as EvalFailure).errorMessage !== "string" ||
        (f as EvalFailure).parameters === null ||
        typeof (f as EvalFailure).parameters !== "object"
      ) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}
