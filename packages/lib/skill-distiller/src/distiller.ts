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

function collectToolNames(trace: DistillationTrace): ReadonlySet<string> {
  const names = new Set<string>();
  for (const turn of trace.turns) {
    if (turn.toolCalls === undefined) continue;
    for (const call of turn.toolCalls) names.add(call.name);
  }
  return names;
}

function ungroundedError(reason: string, errorKind: string): KoiError {
  return {
    code: "VALIDATION",
    message: reason,
    retryable: RETRYABLE_DEFAULTS.VALIDATION,
    context: { errorKind },
  };
}

// Reject hallucinated drafts: every emitted tool must appear in the trace, and
// the draft must carry the discovery surfaces (triggers, toolSequence) needed
// to ever be retrieved or replayed.
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
  const observed = collectToolNames(trace);
  for (const tool of draft.toolSequence) {
    if (!observed.has(tool)) {
      return {
        ok: false,
        error: ungroundedError(
          `toolSequence contains "${tool}" which never appears in the trace`,
          "DRAFT_TOOL_NOT_GROUNDED",
        ),
      };
    }
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
