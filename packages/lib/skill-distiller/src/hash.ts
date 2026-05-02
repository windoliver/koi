import { computeStringHash } from "@koi/hash";
import type { DistillationTrace, SkillDraft } from "./types.js";

// Use canonical JSON instead of ad-hoc separator joining so user-controlled
// strings cannot collide by embedding the separator byte. Object keys are
// sorted recursively for stable serialization regardless of input ordering.

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  const obj = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) {
    out[key] = canonicalize(obj[key]);
  }
  return out;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

/**
 * Stable content identity for a draft.
 *
 * Includes every field that changes the skill's behavior so two materially
 * different drafts never collide:
 *   - name
 *   - ordered toolSequence (procedure order matters)
 *   - sorted parameter contracts (name + required) — toggling `required`
 *     changes the invocation contract and must move the hash
 *   - sorted triggers (entry phrases — discovery surface)
 *   - sorted expectedInputs / expectedOutputs (contract surface)
 *
 * Parameter description and top-level description are excluded (prose, not
 * contract). The hash input is canonical JSON, so embedded separator/control
 * characters in any string field cannot cause collisions.
 */
export function computeDraftHash(draft: SkillDraft): string {
  const sortedTriggers = [...draft.triggers].sort();
  const sortedInputs = [...draft.expectedInputs].sort();
  const sortedOutputs = [...draft.expectedOutputs].sort();
  const sortedParameters = [...draft.parameters]
    .map((p) => ({ name: p.name, required: p.required }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return computeStringHash(
    canonicalJson({
      name: draft.name,
      toolSequence: draft.toolSequence,
      parameters: sortedParameters,
      triggers: sortedTriggers,
      expectedInputs: sortedInputs,
      expectedOutputs: sortedOutputs,
    }),
  );
}

/**
 * Content provenance — hash of the trace material that actually fed distillation.
 *
 * Includes traceId, sessionId, and a canonicalized digest of every turn (role,
 * text, ordered tool calls with name + args). Two transcripts that share IDs but
 * differ in content produce different hashes, so a retry, redaction, or ID reuse
 * is auditable rather than silently aliased onto the original.
 */
export function computeSourceHash(trace: DistillationTrace): string {
  return computeStringHash(
    canonicalJson({
      traceId: trace.traceId,
      sessionId: trace.sessionId ?? "",
      turns: trace.turns.map((t) => ({
        role: t.role,
        text: t.text ?? "",
        toolCalls: (t.toolCalls ?? []).map((c) => ({ name: c.name, argsJson: c.argsJson })),
      })),
    }),
  );
}
