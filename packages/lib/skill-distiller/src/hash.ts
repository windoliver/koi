import { computeStringHash } from "@koi/hash";
import type { DistillationTrace, SkillDraft } from "./types.js";

/**
 * Stable procedural fingerprint of a draft.
 *
 * Hashes name + sorted toolSequence so two drafts that wrap the same procedure
 * dedupe even if their description wording differs. Parameters are intentionally
 * excluded — minor parameter wording would otherwise create near-duplicates.
 */
export function computeDraftHash(draft: SkillDraft): string {
  const sortedTools = [...draft.toolSequence].sort().join(" ");
  return computeStringHash(`${draft.name}\n${sortedTools}`);
}

/**
 * Provenance anchor — short hash that identifies the source trace.
 * Does not include full transcripts: the caller can re-fetch the trace by id.
 */
export function computeSourceHash(trace: DistillationTrace): string {
  const session = trace.sessionId ?? "";
  return computeStringHash(`${trace.traceId}\n${session}\n${trace.turns.length}`);
}
