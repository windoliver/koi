/**
 * prepare_handoff tool factory — creates a Tool that packages work
 * into a typed HandoffEnvelope for the next agent.
 */

import type {
  AgentId,
  ArtifactRef,
  DecisionRecord,
  DelegationGrant,
  HandoffEnvelope,
  HandoffEvent,
  HandoffId,
  JsonObject,
  Tool,
} from "@koi/core";
import { agentId, handoffId, toolCallId } from "@koi/core";
import type { HandoffStore } from "./store.js";
import { PREPARE_HANDOFF_DESCRIPTOR } from "./types.js";
import { validateArtifactRefs, validatePrepareInput } from "./validate.js";

export interface CreatePrepareToolConfig {
  readonly store: HandoffStore;
  readonly agentId: AgentId;
  readonly onEvent?: ((event: HandoffEvent) => void) | undefined;
}

export function createPrepareTool(config: CreatePrepareToolConfig): Tool {
  return {
    descriptor: PREPARE_HANDOFF_DESCRIPTOR,
    trustTier: "verified",

    async execute(args: JsonObject): Promise<unknown> {
      const validation = validatePrepareInput(args);
      if (!validation.ok) {
        return { error: validation.message };
      }

      const input = validation.value;

      // Validate artifact refs — collect warnings
      const artifacts: readonly ArtifactRef[] = input.artifacts ?? [];
      const artifactWarnings = validateArtifactRefs(artifacts);

      // Map decision records to branded types
      const decisions: readonly DecisionRecord[] = (input.decisions ?? []).map((d) => ({
        agentId: agentId(d.agentId),
        action: d.action,
        reasoning: d.reasoning,
        timestamp: d.timestamp,
        toolCallId: d.toolCallId !== undefined ? toolCallId(d.toolCallId) : undefined,
      }));

      // Merge artifact warnings into context warnings
      const allWarnings = [...(input.warnings ?? []), ...artifactWarnings];

      const id: HandoffId = handoffId(crypto.randomUUID());

      const envelope: HandoffEnvelope = {
        id,
        from: config.agentId,
        to: agentId(input.to),
        status: "pending",
        createdAt: Date.now(),
        phase: {
          completed: input.completed,
          next: input.next,
        },
        context: {
          results: input.results ?? {},
          artifacts,
          decisions,
          warnings: allWarnings,
        },
        delegation: input.delegation as DelegationGrant | undefined,
        metadata: input.metadata ?? {},
      };

      const putResult = await config.store.put(envelope);
      if (!putResult.ok) {
        return { error: `Failed to store handoff: ${putResult.error.message}` };
      }

      config.onEvent?.({ kind: "handoff:prepared", envelope });

      return { handoffId: id, status: "pending" };
    },
  };
}
