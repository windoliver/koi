/**
 * prepare_handoff tool factory — packages work into a HandoffEnvelope for
 * the next agent in a pipeline. Supports direct (`to`) and capability-based
 * (`capability`) target resolution.
 */

import type {
  AgentId,
  AgentRegistry,
  ArtifactRef,
  DecisionRecord,
  DelegationGrant,
  HandoffEnvelope,
  HandoffEvent,
  HandoffId,
  JsonObject,
  Tool,
} from "@koi/core";
import { agentId, DEFAULT_UNSANDBOXED_POLICY, handoffId, toolCallId } from "@koi/core";
import type { HandoffStore } from "./store.js";
import { PREPARE_HANDOFF_DESCRIPTOR } from "./types.js";
import type { PrepareInput } from "./validate.js";
import { validateArtifactRefs, validatePrepareInput } from "./validate.js";

export type ResolveTargetResult =
  | { readonly ok: true; readonly agentId: AgentId }
  | { readonly ok: false; readonly message: string };

/**
 * Resolve the target agent for a capability-based handoff.
 * Queries registry for running agents declaring the requested capability.
 */
export async function resolveTarget(
  registry: AgentRegistry,
  capability: string,
): Promise<ResolveTargetResult> {
  const entries = await registry.list({ phase: "running", capability });
  const first = entries[0];
  if (first === undefined) {
    return { ok: false, message: `No running agent found with capability "${capability}"` };
  }
  return { ok: true, agentId: first.agentId };
}

export interface CreatePrepareToolConfig {
  readonly store: HandoffStore;
  readonly agentId: AgentId;
  readonly registry?: AgentRegistry | undefined;
  readonly onEvent?: ((event: HandoffEvent) => void) | undefined;
}

export function createPrepareTool(config: CreatePrepareToolConfig): Tool {
  return {
    descriptor: PREPARE_HANDOFF_DESCRIPTOR,
    origin: "primordial",
    policy: DEFAULT_UNSANDBOXED_POLICY,

    async execute(args: JsonObject): Promise<unknown> {
      const validation = validatePrepareInput(args);
      if (!validation.ok) {
        return { error: validation.message };
      }
      const input = validation.value;

      const targetResult = await resolveTargetFromInput(input, config.registry);
      if (!targetResult.ok) {
        return { error: targetResult.message };
      }
      const targetId = targetResult.agentId;

      const artifacts: readonly ArtifactRef[] = input.artifacts ?? [];
      const artifactWarnings = validateArtifactRefs(artifacts);

      const decisions: readonly DecisionRecord[] = (input.decisions ?? []).map((d) => ({
        agentId: agentId(d.agentId),
        action: d.action,
        reasoning: d.reasoning,
        timestamp: d.timestamp,
        toolCallId: d.toolCallId !== undefined ? toolCallId(d.toolCallId) : undefined,
      }));

      const allWarnings = [...(input.warnings ?? []), ...artifactWarnings];

      const id: HandoffId = handoffId(crypto.randomUUID());

      const envelope: HandoffEnvelope = {
        id,
        from: config.agentId,
        to: targetId,
        status: "pending",
        createdAt: Date.now(),
        phase: { completed: input.completed, next: input.next },
        context: {
          results: input.results ?? {},
          artifacts,
          decisions,
          warnings: allWarnings,
        },
        delegation:
          input.delegation !== undefined
            ? // The descriptor types `delegation` as `unknown` — validation is
              // delegated to the consumer that interprets the grant. We pass through.
              (input.delegation as DelegationGrant)
            : undefined,
        metadata: input.metadata ?? {},
      };

      const putResult = await config.store.put(envelope);
      if (!putResult.ok) {
        return { error: `Failed to store handoff: ${putResult.error.message}` };
      }

      config.onEvent?.({ kind: "handoff:prepared", envelope });

      if (input.capability !== undefined) {
        return { handoffId: id, status: "pending", resolvedTo: targetId };
      }
      return { handoffId: id, status: "pending" };
    },
  };
}

async function resolveTargetFromInput(
  input: PrepareInput,
  registry: AgentRegistry | undefined,
): Promise<ResolveTargetResult> {
  if (input.to !== undefined) {
    return { ok: true, agentId: agentId(input.to) };
  }

  const capability = input.capability;
  if (capability === undefined) {
    return { ok: false, message: "Provide exactly one of 'to' or 'capability'" };
  }

  if (registry === undefined) {
    return {
      ok: false,
      message:
        "Cannot resolve capability-based handoff: no registry configured. " +
        "Provide a registry in HandoffConfig or use 'to' with a direct agent ID.",
    };
  }

  try {
    return await resolveTarget(registry, capability);
  } catch (e: unknown) {
    const cause = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      message: `Registry lookup failed for capability "${capability}": ${cause}`,
    };
  }
}
