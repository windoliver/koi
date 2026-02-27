/**
 * Output verifier middleware factory — two-stage quality gate before delivery.
 *
 * Stage 1: Deterministic checks (fast, always runs).
 * Stage 2: LLM-as-judge (async, optional, skipped if Stage 1 blocks).
 *
 * Priority 385: runs after guardrails (375), before memory (400).
 */

import type { InboundMessage } from "@koi/core/message";
import type {
  CapabilityFragment,
  KoiMiddleware,
  ModelChunk,
  ModelHandler,
  ModelRequest,
  ModelResponse,
  ModelStreamHandler,
  TurnContext,
} from "@koi/core/middleware";
import { KoiRuntimeError } from "@koi/errors";
import { buildJudgePrompt, parseJudgeResponse } from "./judge.js";
import type { VerifierConfig, VerifierHandle, VerifierStats, VerifierVetoEvent } from "./types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MIDDLEWARE_NAME = "output-verifier";
const MIDDLEWARE_PRIORITY = 385;
const DEFAULT_MAX_BUFFER_SIZE = 262_144; // 256 KB
const DEFAULT_VETO_THRESHOLD = 0.75;
const DEFAULT_SAMPLING_RATE = 1.0;
const DEFAULT_MAX_REVISIONS = 1;
const DEFAULT_REVISION_FEEDBACK_MAX_LENGTH = 400;
const VERIFIER_SENDER_ID = "system" as const;

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

/** Outcome of a single judge evaluation over one content string. */
type JudgeOutcome =
  | { readonly kind: "pass" }
  | { readonly kind: "skip" } // Not sampled
  | { readonly kind: "warn"; readonly score: number; readonly reasoning: string }
  | {
      readonly kind: "block";
      readonly score: number;
      readonly reasoning: string;
      readonly judgeError?: string;
    }
  | {
      readonly kind: "revise";
      readonly score: number;
      readonly reasoning: string;
      readonly judgeError?: string;
    };

/** Mutable stats counters (not exported). */
interface MutableStats {
  totalChecks: number;
  vetoed: number;
  warned: number;
  deterministicVetoes: number;
  judgeVetoes: number;
  judgedChecks: number;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Creates the output verifier middleware.
 *
 * @throws {KoiRuntimeError} At factory time if neither `deterministic` nor `judge` is configured.
 */
export function createOutputVerifierMiddleware(config: VerifierConfig): VerifierHandle {
  const hasDeterministic = config.deterministic !== undefined && config.deterministic.length > 0;
  const hasJudge = config.judge !== undefined;

  if (!hasDeterministic && !hasJudge) {
    throw KoiRuntimeError.from(
      "VALIDATION",
      "createOutputVerifierMiddleware: at least one of 'deterministic' or 'judge' must be configured",
    );
  }

  const maxBufferSize = config.maxBufferSize ?? DEFAULT_MAX_BUFFER_SIZE;
  const onVeto = config.onVeto;

  // let: mutable judge rubric — updated via handle.setRubric()
  let currentRubric = config.judge?.rubric ?? "";

  const stats: MutableStats = {
    totalChecks: 0,
    vetoed: 0,
    warned: 0,
    deterministicVetoes: 0,
    judgeVetoes: 0,
    judgedChecks: 0,
  };

  // ---------------------------------------------------------------------------
  // Stage 2 helpers
  // ---------------------------------------------------------------------------

  async function runJudge(content: string, signal?: AbortSignal): Promise<JudgeOutcome> {
    const judge = config.judge;
    if (judge === undefined) return { kind: "skip" };

    const samplingRate = judge.samplingRate ?? DEFAULT_SAMPLING_RATE;
    if (Math.random() > samplingRate) return { kind: "skip" };

    stats.judgedChecks++;

    const vetoThreshold = judge.vetoThreshold ?? DEFAULT_VETO_THRESHOLD;
    const judgeAction = judge.action ?? "block";
    const feedbackMaxLength =
      judge.revisionFeedbackMaxLength ?? DEFAULT_REVISION_FEEDBACK_MAX_LENGTH;

    const prompt = buildJudgePrompt(currentRubric, content);

    let score = 0;
    let reasoning = "";
    let judgeError: string | undefined;

    try {
      const response = await judge.modelCall(prompt, signal);
      const parsed = parseJudgeResponse(response);
      score = parsed.score;
      reasoning = parsed.reasoning.slice(0, feedbackMaxLength);
      judgeError = parsed.parseError;
    } catch (e: unknown) {
      judgeError = e instanceof Error ? e.message : "Unknown judge error";
      // Fail-closed: treat judge error as score 0
    }

    if (score >= vetoThreshold && judgeError === undefined) {
      return { kind: "pass" };
    }

    if (judgeAction === "warn") {
      return { kind: "warn", score, reasoning };
    }

    if (judgeAction === "revise") {
      return {
        kind: "revise",
        score,
        reasoning,
        ...(judgeError !== undefined ? { judgeError } : {}),
      };
    }

    // block (default)
    return { kind: "block", score, reasoning, ...(judgeError !== undefined ? { judgeError } : {}) };
  }

  // ---------------------------------------------------------------------------
  // Revision injection
  // ---------------------------------------------------------------------------

  function injectRevisionMessage(request: ModelRequest, feedback: string): ModelRequest {
    const msg: InboundMessage = {
      content: [{ kind: "text", text: feedback }],
      senderId: VERIFIER_SENDER_ID,
      timestamp: Date.now(),
    };
    return { ...request, messages: [...request.messages, msg] };
  }

  function deterministicRevisionFeedback(checkName: string, reason: string): string {
    return `Check "${checkName}" failed: ${reason}. Please revise your output.`;
  }

  function judgeRevisionFeedback(
    score: number,
    vetoThreshold: number,
    reasoning: string,
    feedbackMaxLength: number,
  ): string {
    const reasonPart = reasoning.slice(0, feedbackMaxLength);
    return [
      `Your output was rejected by the quality judge (score: ${score.toFixed(2)}, required: ≥${vetoThreshold}).`,
      reasonPart
        ? `Reason: ${reasonPart}`
        : "Please revise your output to meet the quality criteria.",
    ]
      .filter(Boolean)
      .join(" ");
  }

  // ---------------------------------------------------------------------------
  // Core verification loop (iterative)
  // ---------------------------------------------------------------------------

  async function verify(
    request: ModelRequest,
    next: ModelHandler,
    ctx: TurnContext,
  ): Promise<ModelResponse> {
    const maxRevisions = config.judge?.maxRevisions ?? DEFAULT_MAX_REVISIONS;
    const vetoThreshold = config.judge?.vetoThreshold ?? DEFAULT_VETO_THRESHOLD;
    const feedbackMaxLength =
      config.judge?.revisionFeedbackMaxLength ?? DEFAULT_REVISION_FEEDBACK_MAX_LENGTH;

    // let justified: current request may change across revision attempts
    let currentRequest = request;
    // let justified: revision counter increments across attempts
    let revision = 0;

    // let justified: per-call flags prevent overcounting stats across revision attempts
    let callVetoed = false;
    let callWarned = false;
    let callDeterministicVeto = false;
    let callJudgeVeto = false;

    try {
      while (true) {
        const response = await next(currentRequest);
        const content = response.content;

        // Stage 1: deterministic — process ALL checks, firing events for each.
        // warn: fires event and continues to next check (and then to judge).
        // block: fires event and throws — short-circuits judge.
        // revise: fires event, injects feedback, and restarts the while loop.
        // let justified: tracks whether a revise was triggered this iteration
        let deterministicRevised = false;
        for (const check of config.deterministic ?? []) {
          const result = check.check(content);
          if (result === true) continue;

          const reason = typeof result === "string" ? result : `Check "${check.name}" failed`;

          if (check.action === "warn") {
            callDeterministicVeto = true;
            callWarned = true;
            fireVeto({
              source: "deterministic",
              checkName: check.name,
              checkReason: reason,
              action: "warn",
            });
            continue; // fire event, then check next rule
          }

          if (check.action === "block") {
            callDeterministicVeto = true;
            callVetoed = true;
            fireVeto({
              source: "deterministic",
              checkName: check.name,
              checkReason: reason,
              action: "block",
            });
            throw KoiRuntimeError.from(
              "VALIDATION",
              `Output verifier: deterministic check "${check.name}" blocked output: ${reason}`,
              { context: { checkName: check.name, reason } },
            );
          }

          // action === "revise"
          callDeterministicVeto = true;
          callVetoed = true;
          fireVeto({
            source: "deterministic",
            checkName: check.name,
            checkReason: reason,
            action: "revise",
          });
          if (revision >= maxRevisions) {
            throw KoiRuntimeError.from(
              "VALIDATION",
              `Output verifier: deterministic check "${check.name}" failed after ${maxRevisions} revision(s): ${reason}`,
              { context: { checkName: check.name, reason, revision } },
            );
          }
          revision++;
          currentRequest = injectRevisionMessage(
            currentRequest,
            deterministicRevisionFeedback(check.name, reason),
          );
          deterministicRevised = true;
          break; // Inject feedback for first revise; restart loop
        }
        if (deterministicRevised) continue;

        // Stage 2: judge (skip if Stage 1 blocked — already threw above)
        const judge = await runJudge(content, ctx.signal);

        if (judge.kind === "pass" || judge.kind === "skip") {
          return response;
        }

        if (judge.kind === "warn") {
          callJudgeVeto = true;
          callWarned = true;
          fireVeto({
            source: "judge",
            action: "warn",
            score: judge.score,
            reasoning: judge.reasoning || undefined,
          });
          return response;
        }

        if (judge.kind === "block") {
          callJudgeVeto = true;
          callVetoed = true;
          fireVeto({
            source: "judge",
            action: "block",
            score: judge.score,
            reasoning: judge.reasoning || undefined,
            ...(judge.judgeError !== undefined ? { judgeError: judge.judgeError } : {}),
          });
          throw KoiRuntimeError.from(
            "VALIDATION",
            `Output verifier: judge blocked output (score ${judge.score.toFixed(2)} < ${vetoThreshold})${judge.reasoning ? `: ${judge.reasoning.slice(0, 200)}` : ""}`,
            { context: { score: judge.score, vetoThreshold } },
          );
        }

        // judge.kind === "revise"
        callJudgeVeto = true;
        callVetoed = true;
        fireVeto({
          source: "judge",
          action: "revise",
          score: judge.score,
          reasoning: judge.reasoning || undefined,
          ...(judge.judgeError !== undefined ? { judgeError: judge.judgeError } : {}),
        });
        if (revision >= maxRevisions) {
          throw KoiRuntimeError.from(
            "VALIDATION",
            `Output verifier: judge blocked output after ${maxRevisions} revision(s) (score ${judge.score.toFixed(2)} < ${vetoThreshold})`,
            { context: { score: judge.score, vetoThreshold, revision } },
          );
        }
        revision++;
        currentRequest = injectRevisionMessage(
          currentRequest,
          judgeRevisionFeedback(judge.score, vetoThreshold, judge.reasoning, feedbackMaxLength),
        );
      }
    } finally {
      if (callVetoed) stats.vetoed++;
      if (callWarned) stats.warned++;
      if (callDeterministicVeto) stats.deterministicVetoes++;
      if (callJudgeVeto) stats.judgeVetoes++;
    }
  }

  // ---------------------------------------------------------------------------
  // Veto event helper
  // ---------------------------------------------------------------------------

  function fireVeto(event: VerifierVetoEvent): void {
    onVeto?.(event);
  }

  // ---------------------------------------------------------------------------
  // Streaming helpers
  // ---------------------------------------------------------------------------

  async function verifyStream(content: string, ctx: TurnContext): Promise<void> {
    // Stage 1: deterministic (streaming: ALL actions degrade to warn — content already yielded)
    for (const check of config.deterministic ?? []) {
      const result = check.check(content);
      if (result === true) continue;

      const reason = typeof result === "string" ? result : `Check "${check.name}" failed`;
      const action = check.action;
      const degraded = action === "block" || action === "revise";

      stats.deterministicVetoes++;
      stats.warned++;
      fireVeto({
        source: "deterministic",
        checkName: check.name,
        checkReason: reason,
        action,
        ...(degraded ? { degraded: true } : {}),
      });
      // Don't throw — content was already yielded
    }

    // Stage 2: judge (streaming: revise/block degrade to warn)
    const judge = await runJudge(content, ctx.signal);
    if (judge.kind === "warn") {
      stats.judgeVetoes++;
      stats.warned++;
      fireVeto({
        source: "judge",
        action: "warn",
        score: judge.score,
        reasoning: judge.reasoning || undefined,
      });
    } else if (judge.kind === "block" || judge.kind === "revise") {
      stats.judgeVetoes++;
      stats.warned++; // degraded
      fireVeto({
        source: "judge",
        action: judge.kind,
        score: judge.score,
        reasoning: judge.reasoning || undefined,
        ...(judge.judgeError !== undefined ? { judgeError: judge.judgeError } : {}),
        degraded: true,
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Capability fragment
  // ---------------------------------------------------------------------------

  function buildCapabilityFragment(): CapabilityFragment {
    const { totalChecks, vetoed } = stats;
    const threshold = config.judge?.vetoThreshold ?? DEFAULT_VETO_THRESHOLD;
    const desc = hasJudge
      ? `score ≥${threshold} required. ${vetoed}/${totalChecks} vetoed this session.`
      : `deterministic checks active. ${vetoed}/${totalChecks} blocked this session.`;
    return { label: "output-gate", description: `Output gate: ${desc}` };
  }

  // ---------------------------------------------------------------------------
  // Middleware
  // ---------------------------------------------------------------------------

  const middleware: KoiMiddleware = {
    name: MIDDLEWARE_NAME,
    priority: MIDDLEWARE_PRIORITY,

    describeCapabilities: (_ctx: TurnContext): CapabilityFragment => buildCapabilityFragment(),

    async wrapModelCall(
      ctx: TurnContext,
      request: ModelRequest,
      next: ModelHandler,
    ): Promise<ModelResponse> {
      stats.totalChecks++;
      return await verify(request, next, ctx);
    },

    async *wrapModelStream(
      ctx: TurnContext,
      request: ModelRequest,
      next: ModelStreamHandler,
    ): AsyncIterable<ModelChunk> {
      stats.totalChecks++;
      // let justified: buffer grows across stream chunks
      let buffer = "";
      // let justified: tracks buffer overflow state
      let overflowed = false;

      for await (const chunk of next(request)) {
        if (chunk.kind === "text_delta") {
          if (!overflowed) {
            if (buffer.length + chunk.delta.length > maxBufferSize) {
              overflowed = true;
              fireVeto({
                source: "deterministic",
                checkName: "stream-buffer-overflow",
                checkReason: `Stream buffer exceeded ${maxBufferSize} characters; validation skipped`,
                action: "warn",
                degraded: true,
              });
            } else {
              buffer += chunk.delta;
            }
          }
          yield chunk;
          continue;
        }

        if (chunk.kind === "done") {
          if (!overflowed && buffer.length > 0) {
            const content = buffer;
            buffer = ""; // Release memory before async work
            await verifyStream(content, ctx);
          } else {
            buffer = ""; // Release memory
          }
          yield chunk;
          continue;
        }

        yield chunk;
      }
    },
  };

  // ---------------------------------------------------------------------------
  // Handle
  // ---------------------------------------------------------------------------

  return {
    middleware,

    getStats(): VerifierStats {
      const { totalChecks, vetoed, warned, deterministicVetoes, judgeVetoes, judgedChecks } = stats;
      return {
        totalChecks,
        vetoed,
        warned,
        deterministicVetoes,
        judgeVetoes,
        judgedChecks,
        vetoRate: totalChecks === 0 ? 0 : vetoed / totalChecks,
      };
    },

    setRubric(rubric: string): void {
      currentRubric = rubric;
    },

    reset(): void {
      stats.totalChecks = 0;
      stats.vetoed = 0;
      stats.warned = 0;
      stats.deterministicVetoes = 0;
      stats.judgeVetoes = 0;
      stats.judgedChecks = 0;
    },
  };
}
