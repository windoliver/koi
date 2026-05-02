import type { KoiError, Result } from "@koi/core";
import { RETRYABLE_DEFAULTS } from "@koi/core";
import { groundDraftInTrace } from "./grounding.js";
import { computeDraftHash, computeSourceHash } from "./hash.js";
import { parseSkillDraft } from "./parse.js";
import { renderDistillationPromptDetailed } from "./prompt.js";
import type { DistillationRecord, DistillationTrace, Distiller, DistillerConfig } from "./types.js";

function emptyTraceError(): KoiError {
  return {
    code: "VALIDATION",
    message: "trace must contain at least one turn",
    retryable: RETRYABLE_DEFAULTS.VALIDATION,
    context: { errorKind: "TRACE_EMPTY" },
  };
}

// Preserve the upstream retryability signal so callers can distinguish transient
// provider failures (RATE_LIMIT, TIMEOUT) from terminal ones (INTERNAL, AUTH).
function llmExternalError(cause: KoiError): KoiError {
  return {
    code: "EXTERNAL",
    message: `distiller LLM call failed: ${cause.message}`,
    retryable: cause.retryable,
    context: { errorKind: "LLM_FAILED", causeCode: cause.code },
  };
}

// Patterns that indicate a thrown LLM-client exception is transient and worth
// retrying. Anything else (auth, invalid request, schema, config, bad model)
// is treated as terminal so callers don't waste budget on permanent failures.
const TRANSIENT_THROWN_PATTERNS = [
  /timeout/i,
  /timed?[- ]out/i,
  /abort/i,
  /econn(?:reset|refused|aborted)/i,
  /etimedout/i,
  /socket hang up/i,
  /network/i,
  /rate.?limit/i,
  /too many requests/i,
  /\b429\b/,
  /\b503\b/,
  /\b504\b/,
  /service unavailable/i,
  /temporar(?:y|ily) unavailable/i,
];

function isTransientThrownMessage(message: string): boolean {
  return TRANSIENT_THROWN_PATTERNS.some((p) => p.test(message));
}

// Normalize a thrown LLM-client exception into an EXTERNAL KoiError so
// distill() always honors its Result contract. Default to non-retryable —
// only known-transient signatures (timeout, abort, transport reset, 429/5xx)
// are marked retryable, so permanent faults like auth or bad-request are not
// silently looped over.
function llmThrownError(thrown: unknown): KoiError {
  const message = thrown instanceof Error ? thrown.message : String(thrown);
  const retryable = isTransientThrownMessage(message);
  return {
    code: "EXTERNAL",
    message: `distiller LLM call threw: ${message}`,
    retryable,
    context: { errorKind: "LLM_THREW" },
  };
}

function traceTooLargeError(): KoiError {
  return {
    code: "VALIDATION",
    message:
      "trace exceeds the distillation prompt budget — refusing to distill a truncated trace, which would persist a partial procedure",
    retryable: RETRYABLE_DEFAULTS.VALIDATION,
    context: { errorKind: "TRACE_TOO_LARGE" },
  };
}

async function runDistill(
  trace: DistillationTrace,
  config: DistillerConfig,
  redact: (t: DistillationTrace) => DistillationTrace,
  now: () => number,
): Promise<Result<DistillationRecord, KoiError>> {
  if (trace.turns.length === 0) return { ok: false, error: emptyTraceError() };
  // Two independent deep clones: one feeds the redactor (whose output crosses
  // the trust boundary to the LLM), the other stays inside this process as the
  // raw evidence that grounding/leak-detection runs on. An in-place redactor
  // would otherwise mutate the same object we use for grounding, which would
  // re-open the round-4 hole where redaction can hide real input variability.
  const rawForGrounding = structuredClone(trace);
  const forRedaction = structuredClone(trace);
  const redacted = redact(forRedaction);
  const { prompt, truncated } = renderDistillationPromptDetailed(redacted);
  // Fail closed: a truncated prompt means the LLM never saw the tail of the
  // trace, but grounding accepts contiguous prefixes. Combining those would
  // let us persist a partial procedure that drops the session's later
  // validation/finalization steps.
  if (truncated) return { ok: false, error: traceTooLargeError() };
  let llmResult: Result<string, KoiError>;
  try {
    llmResult = await config.llm({ prompt, modelHint: "cheap" });
  } catch (e: unknown) {
    return { ok: false, error: llmThrownError(e) };
  }
  if (!llmResult.ok) return { ok: false, error: llmExternalError(llmResult.error) };
  const draftResult = parseSkillDraft(llmResult.value);
  if (!draftResult.ok) return draftResult;
  const grounded = groundDraftInTrace(draftResult.value, rawForGrounding);
  if (!grounded.ok) return grounded;
  const draft = grounded.value;
  const record: DistillationRecord = {
    draft,
    source: {
      traceId: trace.traceId,
      ...(trace.sessionId === undefined ? {} : { sessionId: trace.sessionId }),
      timestamp: now(),
      // Hash the redacted trace — that's what actually fed the LLM and what
      // grounding/leak detection ran against. Hashing the raw trace would let
      // two materially different prompt inputs share the same provenance
      // whenever redaction rules changed.
      sourceHash: computeSourceHash(redacted),
    },
    draftHash: computeDraftHash(draft),
  };
  return { ok: true, value: record };
}

export function createDistiller(config: DistillerConfig): Distiller {
  if (config.redactor === undefined && config.allowUnredactedTrace !== true) {
    throw new Error(
      "createDistiller: must supply `redactor` (recommended) or set " +
        "`allowUnredactedTrace: true` to acknowledge that raw trace text and " +
        "tool args will be forwarded to the LLM. The unsafe path is never the default.",
    );
  }
  const now = config.now ?? Date.now;
  const redact = config.redactor ?? ((t) => t);
  return {
    distill: (trace: DistillationTrace) => runDistill(trace, config, redact, now),
  };
}
