import { computeStringHash } from "@koi/hash";
import type { DistillationTrace, SkillDraft } from "./types.js";

const FIELD_SEP = ""; // unit separator — unlikely to collide with field content
const LIST_SEP = ""; // record separator

function joinSorted(values: readonly string[]): string {
  return [...values].sort().join(LIST_SEP);
}

/**
 * Stable content identity for a draft.
 *
 * Includes every field that changes the skill's behavior so two materially
 * different drafts never collide:
 *   - name
 *   - ordered toolSequence (procedure order matters)
 *   - sorted parameter names (order doesn't, presence does)
 *   - sorted triggers (entry phrases — discovery surface)
 *   - sorted expectedInputs / expectedOutputs (contract surface)
 *
 * Description is intentionally excluded: prose wording is not behavior.
 */
export function computeDraftHash(draft: SkillDraft): string {
  const parts: readonly string[] = [
    draft.name,
    draft.toolSequence.join(LIST_SEP),
    joinSorted(draft.parameters.map((p) => p.name)),
    joinSorted(draft.triggers),
    joinSorted(draft.expectedInputs),
    joinSorted(draft.expectedOutputs),
  ];
  return computeStringHash(parts.join(FIELD_SEP));
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
  const session = trace.sessionId ?? "";
  const turns = trace.turns
    .map((t) => {
      const text = t.text ?? "";
      const tools = (t.toolCalls ?? [])
        .map((c) => `${c.name}${LIST_SEP}${c.argsJson}`)
        .join(LIST_SEP);
      return `${t.role}${FIELD_SEP}${text}${FIELD_SEP}${tools}`;
    })
    .join("\n");
  return computeStringHash(`${trace.traceId}\n${session}\n${turns}`);
}
