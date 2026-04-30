/** Inputs that define the agent's mandate for a given session. */
export interface MandateFields {
  readonly agentId: string;
  readonly sessionId: string;
  readonly systemPrompt: string;
  readonly objectives: readonly string[];
}

/**
 * Builds the canonical string representation of the mandate fields.
 * This string is the SHA-256 input for mandateHash computation.
 *
 * Format (v1):
 *   v1\nagentId:{agentId}\nsessionId:{sessionId}\nsystemPrompt:{systemPrompt}\nobjectives:{sorted-join}
 *
 * Objectives are sorted lexicographically before joining — order-invariant.
 * The "v1" prefix enables future format evolution without ambiguity.
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
