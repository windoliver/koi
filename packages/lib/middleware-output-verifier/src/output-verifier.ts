/**
 * Output verifier middleware factory — two-stage quality gate.
 *
 * Stage 1: deterministic checks (sync, fast, always runs).
 * Stage 2: LLM-as-judge (async, optional, sampled, skipped if Stage 1 blocks).
 *
 * Priority 385: between guardrails (375) and memory (400).
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
  SessionContext,
  TurnContext,
} from "@koi/core/middleware";
import { KoiRuntimeError } from "@koi/errors";
import { buildJudgePrompt, parseJudgeResponse } from "./judge.js";
import type {
  DeterministicCheck,
  VerifierConfig,
  VerifierHandle,
  VerifierStats,
  VerifierVetoEvent,
} from "./types.js";

const MIDDLEWARE_NAME = "output-verifier";
const MIDDLEWARE_PRIORITY = 385;
const DEFAULT_MAX_BUFFER_SIZE = 262_144;
const DEFAULT_VETO_THRESHOLD = 0.75;
const DEFAULT_SAMPLING_RATE = 1.0;
const DEFAULT_MAX_REVISIONS = 1;
const DEFAULT_REVISION_FEEDBACK_MAX_LENGTH = 400;
// Bound for the rejected assistant output that revise mode replays into
// the next request. Without a cap, a pathologically long response (the
// exact case `maxLength` policies are meant to catch) gets duplicated
// into the follow-up prompt, blowing the context budget and turning a
// recoverable validation failure into a hard retry failure.
const DEFAULT_REJECTED_REPLAY_MAX_LENGTH = 4_000;
const REJECTED_REPLAY_OMISSION_MARKER = "… [verifier: rejected output truncated]";
// Reserved senderId for verifier-injected messages. Uses the
// "system:internal:*" prefix so transcript persistence layers can skip
// these out of the durable inbound stream — revise feedback drives
// in-flight model behavior but must not be committed as the user's
// turn input.
const VERIFIER_SENDER_ID = "system:internal:verifier";

type JudgeOutcome =
  | { readonly kind: "pass" }
  | { readonly kind: "skip" }
  | {
      readonly kind: "warn";
      readonly score: number;
      readonly reasoning: string;
      readonly judgeError?: string;
    }
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

/** Mutable internal stats counters (private; never exported). */
interface MutableStats {
  totalChecks: number;
  vetoed: number;
  warned: number;
  deterministicVetoes: number;
  judgeVetoes: number;
  judgedChecks: number;
}

/** Per-call accumulator flags — flushed in finally to prevent overcounting on revise loop. */
interface CallFlags {
  vetoed: boolean;
  warned: boolean;
  deterministicVeto: boolean;
  judgeVeto: boolean;
}

/** Result of running a single deterministic check. */
type CheckResult = { readonly kind: "pass" } | { readonly kind: "fail"; readonly reason: string };

function runCheck(check: DeterministicCheck, content: string): CheckResult {
  let result: boolean | string;
  try {
    result = check.check(content);
  } catch (e: unknown) {
    const errorMsg = e instanceof Error ? e.message : "Unknown error";
    return { kind: "fail", reason: `Check "${check.name}" threw: ${errorMsg}` };
  }
  if (result === true) return { kind: "pass" };
  const reason = typeof result === "string" ? result : `Check "${check.name}" failed`;
  return { kind: "fail", reason };
}

function injectRevisionMessage(
  request: ModelRequest,
  feedback: string,
  rejectedContent: string,
): ModelRequest {
  // Stateless model backends do not retain prior turns, so the rejected
  // assistant output must be re-attached to the conversation for revise
  // mode to converge — otherwise the model has no anchor for what to
  // edit and may regenerate a fresh (still-failing) answer.
  const now = Date.now();
  const messages: InboundMessage[] = [...request.messages];
  if (rejectedContent.length > 0) {
    const replay =
      rejectedContent.length > DEFAULT_REJECTED_REPLAY_MAX_LENGTH
        ? rejectedContent.slice(0, DEFAULT_REJECTED_REPLAY_MAX_LENGTH) +
          REJECTED_REPLAY_OMISSION_MARKER
        : rejectedContent;
    messages.push({
      content: [{ kind: "text", text: replay }],
      // Use the verifier-internal prefix so transcript persistence
      // skips this replay too — it's an in-flight anchor for the
      // model, not part of the durable assistant turn history.
      senderId: "system:internal:verifier-replay",
      timestamp: now,
    });
  }
  messages.push({
    content: [{ kind: "text", text: feedback }],
    senderId: VERIFIER_SENDER_ID,
    timestamp: now,
  });
  return { ...request, messages };
}

function deterministicRevisionFeedback(checkName: string, reason: string): string {
  return `Check "${checkName}" failed: ${reason}. Please revise your output.`;
}

function sanitizeJudgeReasoning(reasoning: string, maxLength: number): string {
  // Trust boundary: judge reasoning is untrusted model output, but revise
  // mode needs criterion-specific signal to converge. Sanitize rather than
  // drop:
  //   1. Strip ASCII control chars (incl. CR/LF/tabs) that can break frame.
  //   2. Collapse whitespace runs to single spaces.
  //   3. Escape backslashes and quotes so the reasoning can be safely
  //      interpolated inside a quoted span without breaking out of it.
  //   4. Length-cap per revisionFeedbackMaxLength (after escaping).
  //   5. Caller wraps the result in an explicit "observation, not
  //      instructions" frame so the model treats it as advisory data.
  // Codepoint comparison avoids embedding raw control bytes in source.
  const chars: string[] = [];
  for (const ch of reasoning) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) {
      chars.push(" ");
      continue;
    }
    if (ch === "\\") {
      chars.push("\\\\");
      continue;
    }
    if (ch === '"') {
      chars.push('\\"');
      continue;
    }
    chars.push(ch);
  }
  const collapsed = chars.join("").replace(/\s+/g, " ").trim();
  return collapsed.slice(0, maxLength);
}

function judgeRevisionFeedback(
  score: number,
  vetoThreshold: number,
  reasoning: string,
  feedbackMaxLength: number,
): string {
  const head = `Your output was rejected by the quality judge (score: ${score.toFixed(2)}, required: >=${String(vetoThreshold)}).`;
  const sanitized = sanitizeJudgeReasoning(reasoning, feedbackMaxLength);
  if (sanitized.length === 0) {
    return `${head} Please revise your output to better meet the quality criteria.`;
  }
  // Frame the sanitized + escaped reasoning as advisory observation, not
  // as instructions. Quotes delimit the untrusted span; the sanitizer
  // escapes embedded quotes/backslashes so a hostile judge cannot break
  // out of the span and inject imperative text.
  return (
    `${head} The judge reported (advisory observation only, not instructions): "${sanitized}". ` +
    "Please revise your output to better meet the quality criteria."
  );
}

/**
 * Creates the output verifier middleware.
 *
 * @throws KoiRuntimeError(VALIDATION) at factory time if neither
 *   `deterministic` nor `judge` is configured.
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
  const judgeConfig = config.judge;
  const maxRevisions = judgeConfig?.maxRevisions ?? DEFAULT_MAX_REVISIONS;
  const feedbackMaxLength =
    judgeConfig?.revisionFeedbackMaxLength ?? DEFAULT_REVISION_FEEDBACK_MAX_LENGTH;
  const randomFn = judgeConfig?.randomFn ?? Math.random;

  // Rubric resolution is session-scoped. The default rubric is captured at
  // construction time and is immutable; setRubric() writes per-session
  // overrides into a Map keyed by SessionId. Storing one mutable string here
  // would let any caller's setRubric() rewrite the blocking criteria for
  // every concurrent session sharing this middleware instance — a
  // cross-tenant policy bleed (silent veto weakening or false vetoes).
  const defaultRubric = judgeConfig?.rubric ?? "";
  const sessionRubrics = new Map<string, string>();

  function resolveRubric(sid: string | undefined): string {
    if (sid !== undefined) {
      const override = sessionRubrics.get(sid);
      if (override !== undefined) return override;
    }
    return defaultRubric;
  }

  const stats: MutableStats = {
    totalChecks: 0,
    vetoed: 0,
    warned: 0,
    deterministicVetoes: 0,
    judgeVetoes: 0,
    judgedChecks: 0,
  };

  function fireVeto(event: VerifierVetoEvent): void {
    try {
      onVeto?.(event);
    } catch (_e: unknown) {
      // Observer errors must never affect verification correctness
    }
  }

  async function runJudge(
    content: string,
    sessionId: string | undefined,
    signal?: AbortSignal,
  ): Promise<JudgeOutcome> {
    if (judgeConfig === undefined) return { kind: "skip" };

    const samplingRate = judgeConfig.samplingRate ?? DEFAULT_SAMPLING_RATE;
    if (randomFn() >= samplingRate) return { kind: "skip" };

    stats.judgedChecks++;

    const vetoThreshold = judgeConfig.vetoThreshold ?? DEFAULT_VETO_THRESHOLD;
    const judgeAction = judgeConfig.action ?? "block";
    const prompt = buildJudgePrompt(resolveRubric(sessionId), content);

    // let justified: filled in try/catch from async work
    let score = 0;
    // let justified: filled in try/catch from async work
    let reasoning = "";
    // let justified: optional error message set on failure
    let judgeError: string | undefined;

    try {
      const response = await judgeConfig.modelCall(prompt, signal);
      const parsed = parseJudgeResponse(response);
      score = parsed.score;
      reasoning = parsed.reasoning.slice(0, feedbackMaxLength);
      judgeError = parsed.parseError;
    } catch (e: unknown) {
      judgeError = e instanceof Error ? e.message : "Unknown judge error";
    }

    if (score >= vetoThreshold && judgeError === undefined) return { kind: "pass" };
    if (judgeAction === "warn") {
      return judgeError === undefined
        ? { kind: "warn", score, reasoning }
        : { kind: "warn", score, reasoning, judgeError };
    }
    if (judgeAction === "revise") {
      return judgeError === undefined
        ? { kind: "revise", score, reasoning }
        : { kind: "revise", score, reasoning, judgeError };
    }
    return judgeError === undefined
      ? { kind: "block", score, reasoning }
      : { kind: "block", score, reasoning, judgeError };
  }

  function attemptRevision(
    revision: number,
    feedback: string,
    source: string,
    currentRequest: ModelRequest,
    rejectedContent: string,
  ): { readonly request: ModelRequest; readonly revision: number } {
    if (revision >= maxRevisions) {
      throw KoiRuntimeError.from(
        "VALIDATION",
        `Output verifier: ${source} failed after ${String(maxRevisions)} revision(s)`,
      );
    }
    return {
      request: injectRevisionMessage(currentRequest, feedback, rejectedContent),
      revision: revision + 1,
    };
  }

  /**
   * Run Stage 1 deterministic checks.
   * @returns "pass" | { kind: "revise", request, revision } — revise restarts the outer loop.
   * Throws on block. Sets call flags inline.
   */
  function runStage1(
    content: string,
    currentRequest: ModelRequest,
    revision: number,
    flags: CallFlags,
  ):
    | { readonly kind: "pass" }
    | { readonly kind: "revised"; readonly request: ModelRequest; readonly revision: number } {
    for (const check of config.deterministic ?? []) {
      const result = runCheck(check, content);
      if (result.kind === "pass") continue;

      const reason = result.reason;

      if (check.action === "warn") {
        flags.deterministicVeto = true;
        flags.warned = true;
        fireVeto({
          source: "deterministic",
          checkName: check.name,
          checkReason: reason,
          action: "warn",
        });
        continue;
      }

      if (check.action === "block") {
        flags.deterministicVeto = true;
        flags.vetoed = true;
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
      flags.deterministicVeto = true;
      flags.vetoed = true;
      fireVeto({
        source: "deterministic",
        checkName: check.name,
        checkReason: reason,
        action: "revise",
      });
      const revised = attemptRevision(
        revision,
        deterministicRevisionFeedback(check.name, reason),
        `deterministic check "${check.name}"`,
        currentRequest,
        content,
      );
      return { kind: "revised", request: revised.request, revision: revised.revision };
    }
    return { kind: "pass" };
  }

  function handleJudgeOutcome(
    outcome: JudgeOutcome,
    currentRequest: ModelRequest,
    revision: number,
    flags: CallFlags,
    rejectedContent: string,
  ):
    | { readonly kind: "pass" }
    | { readonly kind: "revised"; readonly request: ModelRequest; readonly revision: number } {
    if (outcome.kind === "pass" || outcome.kind === "skip") return { kind: "pass" };

    if (outcome.kind === "warn") {
      flags.judgeVeto = true;
      flags.warned = true;
      fireVeto({
        source: "judge",
        action: "warn",
        score: outcome.score,
        reasoning: outcome.reasoning || undefined,
        ...(outcome.judgeError !== undefined ? { judgeError: outcome.judgeError } : {}),
      });
      return { kind: "pass" };
    }

    const vetoThreshold = judgeConfig?.vetoThreshold ?? DEFAULT_VETO_THRESHOLD;

    if (outcome.kind === "block") {
      flags.judgeVeto = true;
      flags.vetoed = true;
      fireVeto({
        source: "judge",
        action: "block",
        score: outcome.score,
        reasoning: outcome.reasoning || undefined,
        ...(outcome.judgeError !== undefined ? { judgeError: outcome.judgeError } : {}),
      });
      throw KoiRuntimeError.from(
        "VALIDATION",
        `Output verifier: judge blocked output (score ${outcome.score.toFixed(2)} < ${String(vetoThreshold)})`,
        { context: { score: outcome.score, vetoThreshold } },
      );
    }

    // outcome.kind === "revise"
    flags.judgeVeto = true;
    flags.vetoed = true;
    fireVeto({
      source: "judge",
      action: "revise",
      score: outcome.score,
      reasoning: outcome.reasoning || undefined,
      ...(outcome.judgeError !== undefined ? { judgeError: outcome.judgeError } : {}),
    });
    const revised = attemptRevision(
      revision,
      judgeRevisionFeedback(outcome.score, vetoThreshold, outcome.reasoning, feedbackMaxLength),
      "judge",
      currentRequest,
      rejectedContent,
    );
    return { kind: "revised", request: revised.request, revision: revised.revision };
  }

  async function verify(
    request: ModelRequest,
    next: ModelHandler,
    ctx: TurnContext,
  ): Promise<ModelResponse> {
    // let justified: request mutates across revision attempts
    let currentRequest = request;
    // let justified: revision counter increments across attempts
    let revision = 0;
    const flags: CallFlags = {
      vetoed: false,
      warned: false,
      deterministicVeto: false,
      judgeVeto: false,
    };

    try {
      while (true) {
        const response = await next(currentRequest);
        // Combine `content` with any text blocks in `richContent` so
        // the verifier inspects the full user-visible text surface.
        // Otherwise a model could keep a short safe `content` string
        // while placing policy-violating text in richContent (or vice
        // versa) and bypass deterministic checks and judge review.
        const richText =
          response.richContent
            ?.filter(
              (b): b is { readonly kind: "text"; readonly text: string } => b.kind === "text",
            )
            .map((b) => b.text)
            .join("") ?? "";
        const verifiableText =
          response.content.length > 0 && richText.length > 0
            ? `${response.content}\n${richText}`
            : response.content.length > 0
              ? response.content
              : richText;
        // Skip verification only on tool-use-only turns with no text
        // in either channel — actionable output lives in tool_call
        // blocks and feeding "" into nonEmpty/maxLength would
        // false-positive.
        if (response.stopReason === "tool_use" && verifiableText.length === 0) {
          return response;
        }
        const stage1 = runStage1(verifiableText, currentRequest, revision, flags);
        if (stage1.kind === "revised") {
          currentRequest = stage1.request;
          revision = stage1.revision;
          continue;
        }

        const outcome = await runJudge(verifiableText, ctx.session?.sessionId, ctx.signal);
        const stage2 = handleJudgeOutcome(outcome, currentRequest, revision, flags, verifiableText);
        if (stage2.kind === "revised") {
          currentRequest = stage2.request;
          revision = stage2.revision;
          continue;
        }

        return response;
      }
    } finally {
      if (flags.vetoed) stats.vetoed++;
      if (flags.warned) stats.warned++;
      if (flags.deterministicVeto) stats.deterministicVetoes++;
      if (flags.judgeVeto) stats.judgeVetoes++;
    }
  }

  async function verifyStream(content: string, ctx: TurnContext): Promise<void> {
    // Streaming: every action degrades to warn (content already yielded).
    // let justified: per-call accumulator flags (single-shot, no revise loop in streaming)
    let warned = false;
    // let justified: accumulator
    let detVeto = false;
    // let justified: accumulator
    let judgeVeto = false;

    for (const check of config.deterministic ?? []) {
      const result = runCheck(check, content);
      if (result.kind === "pass") continue;
      const degraded = check.action === "block" || check.action === "revise";
      detVeto = true;
      warned = true;
      fireVeto({
        source: "deterministic",
        checkName: check.name,
        checkReason: result.reason,
        action: check.action,
        ...(degraded ? { degraded: true } : {}),
      });
    }

    const outcome = await runJudge(content, ctx.session?.sessionId, ctx.signal);
    if (outcome.kind === "warn") {
      judgeVeto = true;
      warned = true;
      fireVeto({
        source: "judge",
        action: "warn",
        score: outcome.score,
        reasoning: outcome.reasoning || undefined,
        ...(outcome.judgeError !== undefined ? { judgeError: outcome.judgeError } : {}),
      });
    } else if (outcome.kind === "block" || outcome.kind === "revise") {
      judgeVeto = true;
      warned = true;
      fireVeto({
        source: "judge",
        action: outcome.kind,
        score: outcome.score,
        reasoning: outcome.reasoning || undefined,
        ...(outcome.judgeError !== undefined ? { judgeError: outcome.judgeError } : {}),
        degraded: true,
      });
    }

    if (warned) stats.warned++;
    if (detVeto) stats.deterministicVetoes++;
    if (judgeVeto) stats.judgeVetoes++;
  }

  const stages: readonly string[] = [
    ...(hasDeterministic ? ["deterministic checks"] : []),
    ...(hasJudge
      ? [`judge (>=${String(judgeConfig?.vetoThreshold ?? DEFAULT_VETO_THRESHOLD)})`]
      : []),
  ];
  const capabilityPrefix = `Output gate: ${stages.join(" + ")}.`;

  const middleware: KoiMiddleware = {
    name: MIDDLEWARE_NAME,
    priority: MIDDLEWARE_PRIORITY,

    describeCapabilities(_ctx: TurnContext): CapabilityFragment {
      return {
        label: "output-gate",
        description: `${capabilityPrefix} ${String(stats.vetoed)}/${String(stats.totalChecks)} vetoed.`,
      };
    },

    async wrapModelCall(
      ctx: TurnContext,
      request: ModelRequest,
      next: ModelHandler,
    ): Promise<ModelResponse> {
      stats.totalChecks++;
      return await verify(request, next, ctx);
    },

    wrapModelStream(
      ctx: TurnContext,
      request: ModelRequest,
      next: ModelStreamHandler,
    ): AsyncIterable<ModelChunk> {
      stats.totalChecks++;
      return streamGenerator(ctx, request, next);
    },

    async onSessionEnd(ctx: SessionContext): Promise<void> {
      sessionRubrics.delete(ctx.sessionId as string);
    },
  };

  async function* streamGenerator(
    ctx: TurnContext,
    request: ModelRequest,
    next: ModelStreamHandler,
  ): AsyncIterable<ModelChunk> {
    // Mutation justified: hot-loop buffer; immutable spread would be O(n²).
    const bufferChunks: string[] = [];
    // let justified: tracks buffer length for overflow check
    let bufferLength = 0;
    // let justified: overflow flag
    let overflowed = false;

    // Buffer all text deltas BEFORE yielding any chunk. If the buffer
    // exceeds maxBufferSize, fail closed by throwing — but only at the
    // first chunk (i.e. before the consumer sees any output), not
    // after partial emission. This avoids the "partial output + late
    // exception" failure mode where clients persist a prefix and then
    // see a terminal error. The delay is bounded by maxBufferSize.
    let firstYielded = false;
    for await (const chunk of next(request)) {
      if (chunk.kind === "text_delta") {
        if (!overflowed) {
          if (bufferLength + chunk.delta.length > maxBufferSize) {
            overflowed = true;
            // If we've already started yielding, degrade to warn so we
            // don't strand the consumer with a partial prefix + error.
            // Otherwise (buffer overflow before first yield), fail
            // closed: refuse the stream up front.
            if (firstYielded) {
              stats.warned++;
              stats.deterministicVetoes++;
              fireVeto({
                source: "deterministic",
                checkName: "stream-buffer-overflow",
                checkReason: `Stream buffer exceeded ${String(maxBufferSize)} characters; further chunks pass through unverified`,
                action: "warn",
                degraded: true,
              });
              yield chunk;
              continue;
            }
            stats.vetoed++;
            stats.deterministicVetoes++;
            fireVeto({
              source: "deterministic",
              checkName: "stream-buffer-overflow",
              checkReason: `Stream buffer exceeded ${String(maxBufferSize)} characters; verification cannot complete`,
              action: "block",
            });
            throw KoiRuntimeError.from(
              "VALIDATION",
              `Output verifier: streamed output exceeded ${String(maxBufferSize)}-char buffer before first emission; verification cannot complete`,
              { context: { maxBufferSize } },
            );
          }
          bufferChunks.push(chunk.delta);
          bufferLength += chunk.delta.length;
        }
        firstYielded = true;
        yield chunk;
        continue;
      }

      if (chunk.kind === "done") {
        if (!overflowed) {
          // Prefer the assembled text_delta buffer; fall back to the
          // adapter's final response.content so adapters that emit only
          // `done` (no text_delta chunks) still get verified.
          // Skip verification on tool-use-only turns (stopReason="tool_use"
          // with no text content) — actionable output lives in richContent
          // and feeding "" into nonEmpty/maxLength would false-positive.
          // Combine the streamed text-delta buffer (or done-only
          // response.content) with any text blocks in richContent so
          // streaming verification inspects the full user-visible
          // text surface — same contract as the non-streaming path.
          // A model could otherwise stream a short safe text payload
          // and bury policy-violating text in richContent text blocks.
          const richText =
            chunk.response.richContent
              ?.filter(
                (b): b is { readonly kind: "text"; readonly text: string } => b.kind === "text",
              )
              .map((b) => b.text)
              .join("") ?? "";
          const isToolUseOnly =
            bufferLength === 0 &&
            chunk.response.stopReason === "tool_use" &&
            (chunk.response.content ?? "").length === 0 &&
            richText.length === 0;
          if (!isToolUseOnly) {
            const baseContent =
              bufferLength > 0 ? bufferChunks.join("") : (chunk.response.content ?? "");
            const content =
              baseContent.length > 0 && richText.length > 0
                ? `${baseContent}\n${richText}`
                : baseContent.length > 0
                  ? baseContent
                  : richText;
            // Apply the same maxBufferSize guard to the done-only fallback:
            // an adapter that emits large response.content without any
            // text_delta chunks would otherwise force unbounded verification
            // work and defeat the existing overflow cap.
            if (content.length > maxBufferSize) {
              // Mirror the text_delta overflow fail-closed semantics:
              // an adapter that buffers internally and emits only
              // `done` could otherwise return arbitrarily large
              // unverified output, defeating block/revise policies on
              // exactly the path where validation cannot complete.
              stats.vetoed++;
              stats.deterministicVetoes++;
              fireVeto({
                source: "deterministic",
                checkName: "stream-buffer-overflow",
                checkReason: `Stream buffer exceeded ${String(maxBufferSize)} characters; verification cannot complete`,
                action: "block",
              });
              throw KoiRuntimeError.from(
                "VALIDATION",
                `Output verifier: streamed output exceeded ${String(maxBufferSize)}-char buffer (done-only fallback); verification cannot complete`,
                { context: { maxBufferSize } },
              );
            }
            await verifyStream(content, ctx);
          }
          bufferChunks.length = 0;
        } else {
          bufferChunks.length = 0;
        }
        yield chunk;
        continue;
      }

      yield chunk;
    }
  }

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

    setRubric(sessionId: string, rubric: string): void {
      sessionRubrics.set(sessionId, rubric);
    },

    clearRubric(sessionId: string): void {
      sessionRubrics.delete(sessionId);
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
