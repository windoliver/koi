import type { KoiError, Result } from "@koi/core";
import { RETRYABLE_DEFAULTS } from "@koi/core";
import { computeDraftHash, computeSourceHash } from "./hash.js";
import { parseSkillDraft } from "./parse.js";
import { renderDistillationPrompt } from "./prompt.js";
import type {
  DistillationRecord,
  DistillationTrace,
  Distiller,
  DistillerConfig,
  SkillDraft,
} from "./types.js";

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

function flattenToolCalls(trace: DistillationTrace): readonly string[] {
  const calls: string[] = [];
  for (const turn of trace.turns) {
    if (turn.toolCalls === undefined) continue;
    for (const call of turn.toolCalls) calls.push(call.name);
  }
  return calls;
}

function ungroundedError(reason: string, errorKind: string): KoiError {
  return {
    code: "VALIDATION",
    message: reason,
    retryable: RETRYABLE_DEFAULTS.VALIDATION,
    context: { errorKind },
  };
}

// Two-pointer subsequence test: every element of `needle` must appear in
// `haystack` in the same relative order (gaps allowed, repeats consumed).
function isOrderedSubsequence(needle: readonly string[], haystack: readonly string[]): boolean {
  let i = 0;
  for (const item of haystack) {
    if (i < needle.length && needle[i] === item) i += 1;
  }
  return i === needle.length;
}

// Reject hallucinated drafts: the emitted toolSequence must be an ordered
// subsequence of the trace's actual tool-call stream (the prompt declares
// toolSequence as the *ordered* procedure, so a reordered draft is wrong even
// if every name appears somewhere). Triggers and a non-empty toolSequence are
// required so the skill remains discoverable and replayable.
function groundDraftInTrace(
  draft: SkillDraft,
  trace: DistillationTrace,
): Result<SkillDraft, KoiError> {
  if (draft.toolSequence.length === 0) {
    return { ok: false, error: ungroundedError("toolSequence is empty", "DRAFT_TOOLS_EMPTY") };
  }
  if (draft.triggers.length === 0) {
    return { ok: false, error: ungroundedError("triggers is empty", "DRAFT_TRIGGERS_EMPTY") };
  }
  const observed = flattenToolCalls(trace);
  if (!isOrderedSubsequence(draft.toolSequence, observed)) {
    return {
      ok: false,
      error: ungroundedError(
        `toolSequence ${JSON.stringify(draft.toolSequence)} is not an ordered subsequence of the trace's tool calls ${JSON.stringify(observed)}`,
        "DRAFT_TOOL_NOT_GROUNDED",
      ),
    };
  }
  return { ok: true, value: draft };
}

export function createDistiller(config: DistillerConfig): Distiller {
  const now = config.now ?? Date.now;
  return {
    distill: async (trace: DistillationTrace): Promise<Result<DistillationRecord, KoiError>> => {
      if (trace.turns.length === 0) {
        return { ok: false, error: emptyTraceError() };
      }
      const prompt = renderDistillationPrompt(trace);
      const llmResult = await config.llm({ prompt, modelHint: "cheap" });
      if (!llmResult.ok) {
        return { ok: false, error: llmExternalError(llmResult.error) };
      }
      const draftResult = parseSkillDraft(llmResult.value);
      if (!draftResult.ok) return draftResult;
      const grounded = groundDraftInTrace(draftResult.value, trace);
      if (!grounded.ok) return grounded;
      const draft = grounded.value;
      const record: DistillationRecord = {
        draft,
        source: {
          traceId: trace.traceId,
          ...(trace.sessionId === undefined ? {} : { sessionId: trace.sessionId }),
          timestamp: now(),
          sourceHash: computeSourceHash(trace),
        },
        draftHash: computeDraftHash(draft),
      };
      return { ok: true, value: record };
    },
  };
}
