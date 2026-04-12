/**
 * @koi/outcome-evaluator — LLM-as-judge rubric iteration loop.
 *
 * Hooks into onBeforeStop to evaluate agent output against a structured rubric
 * using a separate grader model call. Re-prompts with structured feedback until
 * all required criteria pass or the iteration budget is exhausted.
 */

import type {
  KoiMiddleware,
  ModelChunk,
  ModelRequest,
  ModelStreamHandler,
  OutcomeEvaluation,
  OutcomeRubric,
  RubricCriterion,
  SessionContext,
  SessionId,
  StopGateResult,
  TurnContext,
} from "@koi/core";
import { KoiRuntimeError } from "@koi/errors";
import { estimateTokens } from "@koi/token-estimator";
import { createCircuitBreaker } from "./circuit-breaker.js";
import { parseGraderResponse } from "./parse-grader-response.js";
import { buildGraderPrompt } from "./prompt-builder.js";
import type {
  OutcomeEvaluationEvent,
  OutcomeEvaluatorConfig,
  OutcomeEvaluatorHandle,
  OutcomeEvaluatorStats,
} from "./types.js";

// ---------------------------------------------------------------------------
// Internal session state
// ---------------------------------------------------------------------------

interface MutableStats {
  totalEvaluations: number;
  satisfied: number;
  circuitBreaks: number;
  graderErrors: number;
}

interface SessionState {
  // let justified: mutable iteration counter reset per run
  iteration: number;
  // let justified: mutable last model output captured by wrapModelStream
  capturedText: string;
  readonly circuitBreaker: ReturnType<typeof createCircuitBreaker>;
  // let justified: mutable stats accumulator
  readonly stats: MutableStats;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_ITERATIONS_CEILING = 20;
const DEFAULT_MAX_ITERATIONS = 3;
const DEFAULT_GRADER_TIMEOUT_MS = 30_000;
const DEFAULT_CIRCUIT_BREAK_COUNT = 2;
const CHARS_PER_TOKEN = 4; // matches @koi/token-estimator HEURISTIC_ESTIMATOR

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createOutcomeEvaluatorMiddleware(
  config: OutcomeEvaluatorConfig,
): OutcomeEvaluatorHandle {
  const effectiveMaxIter = config.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  const graderTimeoutMs = config.graderTimeoutMs ?? DEFAULT_GRADER_TIMEOUT_MS;
  const circuitBreakAt =
    config.circuitBreakConsecutiveIdenticalFailures ?? DEFAULT_CIRCUIT_BREAK_COUNT;
  const onGraderError = config.onGraderError ?? "fail_closed";

  // --- Construction-time validation ---
  if (effectiveMaxIter > MAX_ITERATIONS_CEILING) {
    throw KoiRuntimeError.from(
      "VALIDATION",
      `OutcomeEvaluator maxIterations (${effectiveMaxIter}) exceeds ceiling of ${MAX_ITERATIONS_CEILING}`,
    );
  }
  if (config.engineStopRetryCap !== undefined && effectiveMaxIter > config.engineStopRetryCap) {
    throw KoiRuntimeError.from(
      "VALIDATION",
      `OutcomeEvaluator maxIterations (${effectiveMaxIter}) exceeds engineStopRetryCap ` +
        `(${config.engineStopRetryCap}). Pass maxStopRetries: ${effectiveMaxIter} in EngineInput.`,
    );
  }

  // Session state keyed by sessionId string. Cleaned up in onSessionEnd.
  const sessions = new Map<string, SessionState>();

  function getOrCreate(sessionId: string): SessionState {
    const existing = sessions.get(sessionId);
    if (existing !== undefined) return existing;
    const state: SessionState = {
      iteration: 0,
      capturedText: "",
      circuitBreaker: createCircuitBreaker(circuitBreakAt),
      stats: { totalEvaluations: 0, satisfied: 0, circuitBreaks: 0, graderErrors: 0 },
    };
    sessions.set(sessionId, state);
    return state;
  }

  function emit(event: OutcomeEvaluationEvent): void {
    config.onEvent?.(event);
  }

  // ---------------------------------------------------------------------------
  // Grader execution helpers
  // ---------------------------------------------------------------------------

  async function callGraderWithTimeout(prompt: string): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), graderTimeoutMs);
    try {
      return await config.graderModelCall(prompt, controller.signal);
    } finally {
      clearTimeout(timer);
    }
  }

  async function runSingleCallGrader(
    rubric: OutcomeRubric,
    artifact: string,
  ): Promise<OutcomeEvaluation | null> {
    const prompt = buildGraderPrompt(rubric, artifact);
    try {
      const raw = await callGraderWithTimeout(prompt);
      const result = parseGraderResponse(raw, rubric, 0 /* iteration set later */);
      if (!result.ok) return null;
      return result.value;
    } catch (e: unknown) {
      if (e instanceof Error && e.name === "AbortError") {
        return null; // timeout — caller handles
      }
      return null;
    }
  }

  async function runIsolatedGraders(
    rubric: OutcomeRubric,
    artifact: string,
    iteration: number,
    sessionId: string,
  ): Promise<OutcomeEvaluation | null> {
    const criteria = rubric.criteria as readonly RubricCriterion[];
    const concurrency = config.maxConcurrentGraderCalls ?? criteria.length;

    // Process in batches of `concurrency`
    const allCriteriaResults: Array<import("@koi/core").CriterionResult> = [];
    let lastExplanation = "";
    let hadError = false;

    for (let i = 0; i < criteria.length; i += concurrency) {
      const batch = criteria.slice(i, i + concurrency);
      const results = await Promise.all(
        batch.map(async (criterion) => {
          const prompt = buildGraderPrompt(rubric, artifact, criterion);
          try {
            const raw = await callGraderWithTimeout(prompt);
            const parsed = parseGraderResponse(
              raw,
              { ...rubric, criteria: [criterion] },
              iteration,
            );
            if (!parsed.ok) {
              hadError = true;
              return null;
            }
            return parsed.value;
          } catch (e: unknown) {
            if (e instanceof Error && e.name === "AbortError") {
              emit({ kind: "outcome.grader.timeout", sessionId, graderTimeoutMs });
            }
            hadError = true;
            return null;
          }
        }),
      );

      for (const r of results) {
        if (r === null) continue;
        // Each single-criterion evaluation has exactly one criteria entry
        const criterionResult = r.criteria[0];
        if (criterionResult !== undefined) {
          allCriteriaResults.push(criterionResult);
        }
        if (r.explanation) lastExplanation = r.explanation;
      }
    }

    if (hadError && allCriteriaResults.length === 0) return null;

    // Determine overall result from required criteria
    const requiredFailing = allCriteriaResults.filter(
      (c) => !c.passed && isRequired(rubric, c.name),
    );
    const result =
      requiredFailing.length === 0 ? ("satisfied" as const) : ("needs_revision" as const);

    return {
      result,
      iteration,
      criteria: allCriteriaResults,
      explanation: lastExplanation,
    };
  }

  // ---------------------------------------------------------------------------
  // Artifact collection + truncation
  // ---------------------------------------------------------------------------

  async function collectArtifact(ctx: TurnContext, capturedText: string): Promise<string> {
    let artifact: string;

    if (config.artifactCollector !== undefined) {
      artifact = await config.artifactCollector(ctx, capturedText);
    } else {
      artifact = capturedText;
    }

    if (artifact.trim() === "") {
      throw KoiRuntimeError.from(
        "INTERNAL",
        "OutcomeEvaluator: artifact is empty. The agent produced no text output in this turn. " +
          "Provide a custom artifactCollector if the artifact is stored elsewhere.",
        { retryable: false },
      );
    }

    if (config.maxArtifactTokens !== undefined) {
      const tokens = estimateTokens(artifact);
      if (tokens > config.maxArtifactTokens) {
        // Truncate to last N characters (tail = most recent, most relevant)
        const maxChars = config.maxArtifactTokens * CHARS_PER_TOKEN;
        const truncatedTo = Math.ceil(artifact.length / CHARS_PER_TOKEN);
        artifact = artifact.slice(-maxChars);
        emit({
          kind: "outcome.artifact.truncated",
          sessionId: ctx.session.sessionId as string,
          originalTokens: tokens,
          truncatedTo,
        });
      }
    }

    return artifact;
  }

  // ---------------------------------------------------------------------------
  // Feedback formatting
  // ---------------------------------------------------------------------------

  function formatFeedback(evaluation: OutcomeEvaluation, rubric: OutcomeRubric): string {
    const failingRequired = evaluation.criteria.filter(
      (c) => !c.passed && isRequired(rubric, c.name),
    );
    const lines: string[] = [
      "Your output did not meet the required quality criteria.",
      "",
      "Failing criteria:",
    ];
    for (const c of failingRequired) {
      lines.push(`- ${c.name}: ${c.gap ?? "did not pass"}`);
    }
    if (evaluation.explanation) {
      lines.push("", `Overall assessment: ${evaluation.explanation}`);
    }
    lines.push("", "Please revise your response to address all failing criteria.");
    return lines.join("\n");
  }

  // ---------------------------------------------------------------------------
  // Middleware implementation
  // ---------------------------------------------------------------------------

  const middleware: KoiMiddleware = {
    name: "outcome-evaluator",
    phase: "observe",

    describeCapabilities(_ctx: TurnContext) {
      return {
        label: "outcome-evaluator",
        description: `Rubric evaluation active (${config.rubric.criteria.length} criteria, max ${effectiveMaxIter} iterations)`,
      };
    },

    // Capture last model stream output for artifact collection.
    // Runs on every model stream; last captured text = final agent response.
    wrapModelStream(
      ctx: TurnContext,
      request: ModelRequest,
      next: ModelStreamHandler,
    ): AsyncIterable<ModelChunk> {
      const sessionId = ctx.session.sessionId as string;
      const state = getOrCreate(sessionId);
      return (async function* () {
        const textChunks: string[] = [];
        for await (const chunk of next(request)) {
          if (chunk.kind === "text_delta") textChunks.push(chunk.delta);
          yield chunk;
        }
        // Overwrite on each stream so final response is always captured
        state.capturedText = textChunks.join("");
      })();
    },

    async onBeforeStop(ctx: TurnContext): Promise<StopGateResult> {
      const sessionId = ctx.session.sessionId as string;
      const state = getOrCreate(sessionId);

      state.iteration++;
      state.stats.totalEvaluations++;

      // Budget check: if we've hit maxIterations, allow completion
      if (state.iteration > effectiveMaxIter) {
        const exhaustedEval: OutcomeEvaluation = {
          result: "max_iterations_reached",
          iteration: state.iteration,
          criteria: config.rubric.criteria.map((c) => ({
            name: c.name,
            passed: false,
            gap: "max iterations reached",
          })),
          explanation: `Evaluation budget exhausted after ${effectiveMaxIter} iterations.`,
        };
        emit({ kind: "outcome.evaluation.end", sessionId, evaluation: exhaustedEval });
        return { kind: "continue" };
      }

      emit({ kind: "outcome.evaluation.start", sessionId, iteration: state.iteration });

      // Collect + truncate artifact
      let artifact: string;
      try {
        artifact = await collectArtifact(ctx, state.capturedText);
      } catch (e: unknown) {
        const errorEval: OutcomeEvaluation = {
          result: "grader_error",
          iteration: state.iteration,
          criteria: [],
          explanation: e instanceof Error ? e.message : String(e),
        };
        emit({ kind: "outcome.evaluation.end", sessionId, evaluation: errorEval });
        state.stats.graderErrors++;
        return onGraderError === "fail_open"
          ? { kind: "block", reason: "Artifact collection failed; review required." }
          : { kind: "continue" };
      }

      // Run grader
      let evaluation: OutcomeEvaluation | null;
      let graderTimedOut = false;
      try {
        if (config.isolateCriteria === true) {
          evaluation = await runIsolatedGraders(
            config.rubric,
            artifact,
            state.iteration,
            sessionId,
          );
        } else {
          const result = await runSingleCallGrader(config.rubric, artifact);
          evaluation = result;
          if (evaluation !== null) {
            // Inject correct iteration number (runSingleCallGrader passes 0)
            evaluation = { ...evaluation, iteration: state.iteration };
          }
        }
      } catch (e: unknown) {
        if (e instanceof Error && e.name === "AbortError") {
          graderTimedOut = true;
          emit({ kind: "outcome.grader.timeout", sessionId, graderTimeoutMs });
        }
        evaluation = null;
      }

      // Handle grader failure
      if (evaluation === null) {
        state.stats.graderErrors++;
        const errorEval: OutcomeEvaluation = {
          result: "grader_error",
          iteration: state.iteration,
          criteria: [],
          explanation: graderTimedOut
            ? `Grader timed out after ${graderTimeoutMs}ms`
            : "Grader returned unparseable response",
        };
        emit({ kind: "outcome.evaluation.end", sessionId, evaluation: errorEval });
        return onGraderError === "fail_open"
          ? { kind: "block", reason: "Quality evaluation failed; please retry." }
          : { kind: "continue" };
      }

      emit({ kind: "outcome.evaluation.end", sessionId, evaluation });

      // Circuit breaker check
      const failingRequired = new Set(
        evaluation.criteria
          .filter((c) => !c.passed && isRequired(config.rubric, c.name))
          .map((c) => c.name),
      );
      const circuitTripped = state.circuitBreaker.record(failingRequired);

      if (evaluation.result === "satisfied") {
        state.stats.satisfied++;
        state.circuitBreaker.reset();
        state.iteration = 0; // Reset for potential future sessions
        return { kind: "continue" };
      }

      if (circuitTripped) {
        state.stats.circuitBreaks++;
        return { kind: "continue" }; // Let agent complete despite not satisfying rubric
      }

      // Needs revision — block and provide structured feedback
      return {
        kind: "block",
        reason: formatFeedback(evaluation, config.rubric),
      };
    },

    async onSessionEnd(ctx: SessionContext): Promise<void> {
      sessions.delete(ctx.sessionId as string);
    },
  };

  return {
    middleware,
    getStats(sessionId: SessionId): OutcomeEvaluatorStats {
      const state = sessions.get(sessionId as string);
      if (state === undefined) {
        return { totalEvaluations: 0, satisfied: 0, circuitBreaks: 0, graderErrors: 0 };
      }
      return { ...state.stats };
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isRequired(rubric: OutcomeRubric, criterionName: string): boolean {
  const criterion = rubric.criteria.find((c) => c.name === criterionName);
  return criterion?.required !== false;
}
