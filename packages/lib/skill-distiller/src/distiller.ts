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

// Normalize a thrown LLM-client exception (timeout, abort, transport) into a
// retryable EXTERNAL KoiError so distill() always honors its Result contract.
function llmThrownError(thrown: unknown): KoiError {
  const message = thrown instanceof Error ? thrown.message : String(thrown);
  return {
    code: "EXTERNAL",
    message: `distiller LLM call threw: ${message}`,
    retryable: true,
    context: { errorKind: "LLM_THREW" },
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

const LITERAL_MIN_LENGTH = 6;
const LEAK_PROBE_FIELDS_DOC =
  "description / triggers / expectedInputs / expectedOutputs / parameter fields";

// A trace literal is a string value inside a tool call's argsJson that looks
// like a resource identifier (path, ID, URL, scoped key) — long enough and
// shaped enough that it almost certainly should be parameterized instead of
// burned into a reusable skill description.
function looksLikeResourceLiteral(s: string): boolean {
  if (s.length < LITERAL_MIN_LENGTH) return false;
  if (/^[\s.,!?]+$/.test(s)) return false;
  if (/[/.:_-]/.test(s)) return true;
  if (/^[A-Za-z0-9]{8,}$/.test(s)) return true;
  return false;
}

function collectTraceLiterals(trace: DistillationTrace): readonly string[] {
  const literals = new Set<string>();
  const visit = (v: unknown): void => {
    if (typeof v === "string") {
      if (looksLikeResourceLiteral(v)) literals.add(v);
      return;
    }
    if (Array.isArray(v)) {
      for (const x of v) visit(x);
      return;
    }
    if (v !== null && typeof v === "object") {
      for (const x of Object.values(v as Record<string, unknown>)) visit(x);
    }
  };
  for (const turn of trace.turns) {
    if (turn.toolCalls === undefined) continue;
    for (const call of turn.toolCalls) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(call.argsJson);
      } catch {
        continue; // malformed args contribute no parseable literals
      }
      visit(parsed);
    }
  }
  return [...literals];
}

// Catch the "burned-in target" failure mode: the LLM took a tenant path / file
// path / ID that appeared in a tool call and pasted it verbatim into ANY
// persisted field of the draft. We probe every user-visible string (description,
// triggers, expectedInputs, expectedOutputs, every parameter name + description)
// because each is stored on the DistillationRecord and surfaced downstream.
function collectDraftProbes(draft: SkillDraft): readonly string[] {
  const probes: string[] = [draft.description, ...draft.triggers];
  probes.push(...draft.expectedInputs);
  probes.push(...draft.expectedOutputs);
  for (const p of draft.parameters) {
    probes.push(p.name, p.description);
  }
  return probes;
}

function findLeakedLiteral(draft: SkillDraft, trace: DistillationTrace): string | undefined {
  const literals = collectTraceLiterals(trace);
  if (literals.length === 0) return undefined;
  const probes = collectDraftProbes(draft);
  for (const literal of literals) {
    for (const field of probes) {
      if (field.includes(literal)) return literal;
    }
  }
  return undefined;
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
  const leaked = findLeakedLiteral(draft, trace);
  if (leaked !== undefined) {
    const sample = leaked.length > 60 ? `${leaked.slice(0, 60)}…` : leaked;
    return {
      ok: false,
      error: ungroundedError(
        `${LEAK_PROBE_FIELDS_DOC} contains the trace-specific literal "${sample}" — abstract it through a parameter instead of burning it in`,
        "DRAFT_LITERAL_LEAKED",
      ),
    };
  }
  return { ok: true, value: draft };
}

export function createDistiller(config: DistillerConfig): Distiller {
  const now = config.now ?? Date.now;
  const redact = config.redactor ?? ((t) => t);
  return {
    distill: async (trace: DistillationTrace): Promise<Result<DistillationRecord, KoiError>> => {
      if (trace.turns.length === 0) {
        return { ok: false, error: emptyTraceError() };
      }
      // Redaction runs BEFORE prompt rendering so secrets never reach the LLM.
      // Grounding still uses the redacted trace so the literal-leak check
      // operates on the same tokens the model actually saw.
      const redacted = redact(trace);
      const prompt = renderDistillationPrompt(redacted);
      let llmResult: Result<string, KoiError>;
      try {
        llmResult = await config.llm({ prompt, modelHint: "cheap" });
      } catch (e: unknown) {
        return { ok: false, error: llmThrownError(e) };
      }
      if (!llmResult.ok) {
        return { ok: false, error: llmExternalError(llmResult.error) };
      }
      const draftResult = parseSkillDraft(llmResult.value);
      if (!draftResult.ok) return draftResult;
      const grounded = groundDraftInTrace(draftResult.value, redacted);
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
