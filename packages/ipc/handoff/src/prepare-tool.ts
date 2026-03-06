/**
 * prepare_handoff tool factory — creates a Tool that packages work
 * into a typed HandoffEnvelope for the next agent.
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

// ---------------------------------------------------------------------------
// Capability-based target resolution
// ---------------------------------------------------------------------------

type ResolveTargetResult =
  | { readonly ok: true; readonly agentId: AgentId }
  | { readonly ok: false; readonly message: string };

/**
 * Resolve the target agent for a capability-based handoff.
 * Queries the registry for running agents that declare the requested capability.
 * Returns the first match (deterministic ordering from registry).
 */
export async function resolveTarget(
  registry: AgentRegistry,
  capability: string,
): Promise<ResolveTargetResult> {
  const entries = await registry.list({ phase: "running", capability });
  const first = entries[0];
  if (first === undefined) {
    return {
      ok: false,
      message: `No running agent found with capability "${capability}"`,
    };
  }
  return { ok: true, agentId: first.agentId };
}

// ---------------------------------------------------------------------------
// Tool config & factory
// ---------------------------------------------------------------------------

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

      // Resolve target — either direct `to` or capability-based lookup
      const targetResult = await resolveTargetFromInput(input, config.registry);
      if (!targetResult.ok) {
        return { error: targetResult.message };
      }
      const targetId = targetResult.agentId;

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
        to: targetId,
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

      // Include resolvedTo only for capability-based handoffs
      if (input.capability !== undefined) {
        return { handoffId: id, status: "pending", resolvedTo: targetId };
      }
      return { handoffId: id, status: "pending" };
    },
  };
}

// ---------------------------------------------------------------------------
// Internal helper — resolve target from validated input
// ---------------------------------------------------------------------------

async function resolveTargetFromInput(
  input: PrepareInput,
  registry: AgentRegistry | undefined,
): Promise<ResolveTargetResult> {
  // Direct target — no registry needed
  if (input.to !== undefined) {
    return { ok: true, agentId: agentId(input.to) };
  }

  // Capability-based — requires registry
  // XOR validated upstream: capability is always defined when to is undefined
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
