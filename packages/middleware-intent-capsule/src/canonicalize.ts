/**
 * Canonical mandate payload serialization.
 *
 * Produces a deterministic string over the mandate fields that is used as the
 * SHA-256 hash input. The format is explicit and auditable — no JSON.stringify
 * key-ordering surprises.
 *
 * Format (version 1):
 *   v1\nagentId:{agentId}\nsessionId:{sessionId}\nsystemPrompt:{systemPrompt}\nobjectives:{sorted-join}
 *
 * Rules:
 * - Objectives are sorted lexicographically before joining (deterministic)
 * - Missing/empty objectives produce an empty string after the objectives: prefix
 * - All field separators are literal \n characters
 * - The version prefix ("v1") enables future format changes without ambiguity
 */

/** Inputs that together define the agent's mandate for a given session. */
export interface MandateFields {
  readonly agentId: string;
  readonly sessionId: string;
  readonly systemPrompt: string;
  readonly objectives: readonly string[];
}

/**
 * Builds the canonical string representation of the mandate fields.
 * This string is the input to SHA-256 for mandateHash computation.
 *
 * Pure function — deterministic, no side effects.
 */
export function canonicalizeMandatePayload(fields: MandateFields): string {
  const sortedObjectives = [...fields.objectives].sort().join("\n");
  return [
    "v1",
    `agentId:${fields.agentId}`,
    `sessionId:${fields.sessionId}`,
    `systemPrompt:${fields.systemPrompt}`,
    `objectives:${sortedObjectives}`,
  ].join("\n");
}
