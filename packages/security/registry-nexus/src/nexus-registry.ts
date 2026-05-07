/**
 * Nexus-backed AgentRegistry implementation.
 *
 * Uses Nexus as the authoritative store for agent state. Maintains a local
 * in-memory projection for fast reads, synchronized via periodic polling.
 * Watch events are emitted both from local mutations and from poll-detected
 * remote changes.
 *
 * Dual-generation model: Koi generation (CAS for callers) is tracked in the
 * local projection. Nexus generation (CAS for server) is tracked separately
 * in `nexusGens` and used for Nexus RPC calls.
 */

import type {
  AgentId,
  AgentRegistry,
  AgentStatus,
  KoiError,
  PatchableRegistryFields,
  ProcessState,
  RegistryEntry,
  RegistryEvent,
  RegistryFilter,
  Result,
  TransitionReason,
  VisibilityContext,
} from "@koi/core";
import { agentGroupId, agentId, matchesFilter, VALID_TRANSITIONS, zoneId } from "@koi/core";
import { createListenerSet } from "@koi/event-delivery";
import type { NexusRegistryConfig } from "./config.js";
import { DEFAULT_NEXUS_REGISTRY_CONFIG, validateNexusRegistryConfig } from "./config.js";
import type { NexusAgent } from "./nexus-rpc.js";
import {
  nexusDeleteAgent,
  nexusGetAgent,
  nexusListAgents,
  nexusRegisterAgent,
  nexusTransition,
  nexusUpdateMetadata,
} from "./nexus-rpc.js";
import { decodeKoiStatus, encodeKoiStatus, mapKoiToNexus, mapNexusToKoi } from "./state-mapping.js";

function mapNexusAgentToEntry(agent: NexusAgent): RegistryEntry {
  const metadata = agent.metadata ?? {};
  const koiStatus = decodeKoiStatus(metadata);
  const remotePhase = mapNexusToKoi(agent.state, metadata);

  // Trust koi:status only when its phase matches the authoritative Nexus
  // state. After a partial-failure path (agent_transition succeeded,
  // update_agent_metadata failed), Nexus has advanced but the metadata
  // blob is stale — falling back to the live state prevents a phase rollback
  // on the next poll.
  const trustedKoiStatus =
    koiStatus !== undefined && koiStatus.phase === remotePhase ? koiStatus : undefined;

  const status: AgentStatus = trustedKoiStatus ?? {
    phase: remotePhase,
    generation: agent.generation ?? 0,
    conditions: [],
    lastTransitionAt: Date.now(),
  };

  const parentId = typeof metadata.parentId === "string" ? agentId(metadata.parentId) : undefined;
  const spawner = typeof metadata.spawner === "string" ? agentId(metadata.spawner) : undefined;
  const groupIdValue =
    typeof metadata.groupId === "string" ? agentGroupId(metadata.groupId) : undefined;
  const zoneIdValue =
    typeof agent.zone_id === "string"
      ? zoneId(agent.zone_id)
      : typeof metadata.zoneId === "string"
        ? zoneId(metadata.zoneId)
        : undefined;

  return {
    agentId: agentId(agent.agent_id),
    status,
    agentType: (metadata.agentType as "copilot" | "worker") ?? "worker",
    metadata,
    registeredAt: (metadata.registeredAt as number) ?? Date.now(),
    priority: (metadata.priority as number) ?? 10,
    ...(parentId !== undefined ? { parentId } : {}),
    ...(spawner !== undefined ? { spawner } : {}),
    ...(groupIdValue !== undefined ? { groupId: groupIdValue } : {}),
    ...(zoneIdValue !== undefined ? { zoneId: zoneIdValue } : {}),
  };
}

/**
 * Create a Nexus-backed AgentRegistry.
 *
 * Performs eager warmup by listing all agents from Nexus at startup.
 * Starts a poll timer to keep the local projection in sync.
 */
export async function createNexusRegistry(config: NexusRegistryConfig): Promise<AgentRegistry> {
  const validation = validateNexusRegistryConfig(config);
  if (!validation.ok) {
    throw new Error(validation.error.message, { cause: validation.error });
  }

  const transport = config.transport;
  const maxEntries = config.maxEntries ?? DEFAULT_NEXUS_REGISTRY_CONFIG.maxEntries;
  const pollIntervalMs = config.pollIntervalMs ?? DEFAULT_NEXUS_REGISTRY_CONFIG.pollIntervalMs;
  const startupTimeoutMs =
    config.startupTimeoutMs ?? DEFAULT_NEXUS_REGISTRY_CONFIG.startupTimeoutMs;

  const projection = new Map<AgentId, RegistryEntry>();
  /** Nexus-side generation per agent — separate from Koi generation. */
  const nexusGens = new Map<AgentId, number>();
  const listeners = createListenerSet<RegistryEvent>({
    onError: (err) =>
      console.warn("[registry-nexus] listener threw:", err instanceof Error ? err.message : err),
  });
  // let: timer handle, cleared on dispose
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  // let: disposed flag to gate background work
  let disposed = false;

  const notify = listeners.notify;

  async function loadProjection(): Promise<void> {
    const listResult = await nexusListAgents(transport, config.zoneId);
    if (!listResult.ok) {
      throw new Error(
        `Failed to load agents from Nexus during startup: ${listResult.error.message}`,
        {
          cause: listResult.error,
        },
      );
    }

    projection.clear();
    nexusGens.clear();

    for (const nexusAgent of listResult.value) {
      if (projection.size >= maxEntries) break;
      const detail = await nexusGetAgent(transport, nexusAgent.agent_id);
      if (detail.ok) {
        const entry = mapNexusAgentToEntry(detail.value);
        projection.set(entry.agentId, entry);
        nexusGens.set(entry.agentId, detail.value.generation ?? 0);
      }
    }
  }

  async function poll(): Promise<void> {
    if (disposed) return;

    const listResult = await nexusListAgents(transport, config.zoneId);
    if (!listResult.ok) return;

    const remoteIds = new Set<string>();

    for (const nexusAgent of listResult.value) {
      remoteIds.add(nexusAgent.agent_id);
      const id = agentId(nexusAgent.agent_id);
      const existing = projection.get(id);
      const remoteGen = nexusAgent.generation ?? 0;
      const localNexusGen = nexusGens.get(id) ?? -1;

      if (localNexusGen === remoteGen && existing !== undefined) continue;

      const detail = await nexusGetAgent(transport, nexusAgent.agent_id);
      if (!detail.ok) continue;

      if (projection.size >= maxEntries && existing === undefined) continue;

      const entry = mapNexusAgentToEntry(detail.value);
      projection.set(id, entry);
      nexusGens.set(id, detail.value.generation ?? 0);

      if (existing === undefined) {
        notify({ kind: "registered", entry });
      } else if (existing.status.phase !== entry.status.phase) {
        notify({
          kind: "transitioned",
          agentId: id,
          from: existing.status.phase,
          to: entry.status.phase,
          generation: entry.status.generation,
          reason: entry.status.reason ?? { kind: "assembly_complete" },
        });
      }
    }

    for (const [id] of projection) {
      if (!remoteIds.has(id)) {
        projection.delete(id);
        nexusGens.delete(id);
        notify({ kind: "deregistered", agentId: id });
      }
    }
  }

  async function register(entry: RegistryEntry): Promise<RegistryEntry> {
    const koiMetadata = encodeKoiStatus(entry.status);
    const merged: Record<string, unknown> = {
      ...entry.metadata,
      ...koiMetadata,
      agentType: entry.agentType,
      registeredAt: entry.registeredAt,
      priority: entry.priority,
      ...(entry.parentId !== undefined ? { parentId: entry.parentId } : {}),
      ...(entry.spawner !== undefined ? { spawner: entry.spawner } : {}),
      ...(entry.groupId !== undefined ? { groupId: entry.groupId } : {}),
    };

    const registerResult = await nexusRegisterAgent(transport, {
      agent_id: entry.agentId,
      name: entry.agentId,
      metadata: merged,
      ...(entry.zoneId !== undefined
        ? { zone_id: entry.zoneId }
        : config.zoneId !== undefined
          ? { zone_id: config.zoneId }
          : {}),
    });

    if (!registerResult.ok) {
      throw new Error(
        `Failed to register agent ${entry.agentId} in Nexus: ${registerResult.error.message}`,
        { cause: registerResult.error },
      );
    }

    async function rollbackOrphan(reason: string, cause: unknown): Promise<never> {
      // Best-effort cleanup of the partially-created Nexus record. Swallow
      // delete errors to avoid masking the original failure; surface them as
      // the cause chain instead.
      const deleteAttempt = await nexusDeleteAgent(transport, entry.agentId);
      const failure = !deleteAttempt.ok ? deleteAttempt.error : undefined;
      throw new Error(
        `Failed to register agent ${entry.agentId}: ${reason}${
          failure !== undefined ? ` (rollback also failed: ${failure.message})` : ""
        }`,
        { cause },
      );
    }

    // let: advances through setup transitions
    let currentNexusGen = registerResult.value.generation ?? 0;

    const targetNexusState = mapKoiToNexus(entry.status.phase);
    const connectedResult = await nexusTransition(
      transport,
      entry.agentId,
      "CONNECTED",
      currentNexusGen,
    );
    if (!connectedResult.ok) {
      await rollbackOrphan(
        `transition to CONNECTED failed: ${connectedResult.error.message}`,
        connectedResult.error,
      );
    }
    currentNexusGen = connectedResult.ok
      ? (connectedResult.value.generation ?? currentNexusGen + 1)
      : currentNexusGen;

    if (targetNexusState !== "CONNECTED") {
      const targetResult = await nexusTransition(
        transport,
        entry.agentId,
        targetNexusState,
        currentNexusGen,
      );
      if (!targetResult.ok) {
        await rollbackOrphan(
          `transition to ${targetNexusState} failed: ${targetResult.error.message}`,
          targetResult.error,
        );
      }
      currentNexusGen = targetResult.ok
        ? (targetResult.value.generation ?? currentNexusGen + 1)
        : currentNexusGen;
    }

    if (projection.size < maxEntries) {
      projection.set(entry.agentId, entry);
    }
    nexusGens.set(entry.agentId, currentNexusGen);

    notify({ kind: "registered", entry });
    return entry;
  }

  async function deregister(id: AgentId): Promise<boolean> {
    const existed = projection.has(id);
    if (!existed) return false;

    const deleteResult = await nexusDeleteAgent(transport, id);
    if (!deleteResult.ok) {
      // Nexus is the source of truth — if delete failed there, do not
      // drop local state. Otherwise local would believe the agent is gone
      // while Nexus still has it (split-brain) until the next poll.
      throw new Error(`Failed to delete agent ${id} from Nexus: ${deleteResult.error.message}`, {
        cause: deleteResult.error,
      });
    }
    projection.delete(id);
    nexusGens.delete(id);
    notify({ kind: "deregistered", agentId: id });
    return true;
  }

  function lookup(id: AgentId): RegistryEntry | undefined {
    return projection.get(id);
  }

  function list(filter?: RegistryFilter, _v?: VisibilityContext): readonly RegistryEntry[] {
    const entries = [...projection.values()];
    if (filter === undefined) return entries;
    return entries.filter((e) => matchesFilter(e, filter));
  }

  async function transition(
    id: AgentId,
    targetPhase: ProcessState,
    expectedGeneration: number,
    reason: TransitionReason,
  ): Promise<Result<RegistryEntry, KoiError>> {
    const current = projection.get(id);
    if (current === undefined) {
      return {
        ok: false,
        error: {
          code: "NOT_FOUND",
          message: `Agent ${id} not found in registry`,
          retryable: false,
        },
      };
    }

    if (current.status.generation !== expectedGeneration) {
      return {
        ok: false,
        error: {
          code: "CONFLICT",
          message: `Stale generation: expected ${String(expectedGeneration)}, current ${String(current.status.generation)}`,
          retryable: true,
        },
      };
    }

    const allowed = VALID_TRANSITIONS[current.status.phase];
    if (!allowed.some((s) => s === targetPhase)) {
      return {
        ok: false,
        error: {
          code: "VALIDATION",
          message: `Invalid transition: ${current.status.phase} → ${targetPhase}. Allowed: [${allowed.join(", ")}]`,
          retryable: false,
        },
      };
    }

    const targetNexusState = mapKoiToNexus(targetPhase);
    const currentNexusGen = nexusGens.get(id) ?? 0;
    const nexusResult = await nexusTransition(transport, id, targetNexusState, currentNexusGen);

    if (!nexusResult.ok) {
      if (nexusResult.error.code === "CONFLICT") {
        return {
          ok: false,
          error: {
            code: "CONFLICT",
            message: `Concurrent modification on agent ${id} in Nexus`,
            retryable: true,
          },
        };
      }
      return { ok: false, error: nexusResult.error };
    }

    nexusGens.set(id, nexusResult.value.generation ?? currentNexusGen + 1);

    const newStatus: AgentStatus = {
      phase: targetPhase,
      generation: current.status.generation + 1,
      conditions: [...current.status.conditions],
      reason,
      lastTransitionAt: Date.now(),
    };

    const updateResult = await nexusUpdateMetadata(transport, id, {
      ...current.metadata,
      ...encodeKoiStatus(newStatus),
    });

    if (!updateResult.ok) {
      // The remote phase HAS already advanced via agent_transition. Reflect that
      // in the projection so callers see consistent state instead of the stale
      // pre-transition phase. The richer Koi status (generation, conditions,
      // reason) may not be persisted in Nexus metadata until the next poll
      // cycle re-reads the authoritative record.
      const updated: RegistryEntry = { ...current, status: newStatus };
      projection.set(id, updated);
      notify({
        kind: "transitioned",
        agentId: id,
        from: current.status.phase,
        to: targetPhase,
        generation: newStatus.generation,
        reason,
      });
      return { ok: false, error: updateResult.error };
    }

    if (updateResult.value.generation !== undefined) {
      nexusGens.set(id, updateResult.value.generation);
    }

    const updated: RegistryEntry = { ...current, status: newStatus };
    projection.set(id, updated);

    notify({
      kind: "transitioned",
      agentId: id,
      from: current.status.phase,
      to: targetPhase,
      generation: newStatus.generation,
      reason,
    });

    return { ok: true, value: updated };
  }

  async function patch(
    id: AgentId,
    fields: PatchableRegistryFields,
  ): Promise<Result<RegistryEntry, KoiError>> {
    const current = projection.get(id);
    if (current === undefined) {
      return {
        ok: false,
        error: {
          code: "NOT_FOUND",
          message: `Agent ${id} not found in registry`,
          retryable: false,
        },
      };
    }

    if (fields.zoneId !== undefined) {
      // Nexus does not expose a zone-move RPC, and `update_agent_metadata`
      // does not touch the authoritative `agent.zone_id` field. Accepting
      // a zoneId patch would make the local projection diverge from Nexus
      // and silently revert on the next poll. Fail closed instead.
      return {
        ok: false,
        error: {
          code: "VALIDATION",
          message:
            "patch({ zoneId }) is not supported by registry-nexus — Nexus has no zone-move RPC",
          retryable: false,
        },
      };
    }

    const updated: RegistryEntry = {
      ...current,
      ...(fields.priority !== undefined ? { priority: fields.priority } : {}),
      ...(fields.metadata !== undefined
        ? { metadata: { ...current.metadata, ...fields.metadata } }
        : {}),
    };

    const nexusMeta: Record<string, unknown> = { ...current.metadata };
    if (fields.priority !== undefined) nexusMeta.priority = fields.priority;
    if (fields.metadata !== undefined) Object.assign(nexusMeta, fields.metadata);

    const updateResult = await nexusUpdateMetadata(transport, id, nexusMeta);
    if (!updateResult.ok) {
      if (updateResult.error.code === "CONFLICT") {
        return {
          ok: false,
          error: {
            code: "CONFLICT",
            message: `Concurrent modification on agent ${id} in Nexus`,
            retryable: true,
          },
        };
      }
      return { ok: false, error: updateResult.error };
    }

    if (updateResult.value.generation !== undefined) {
      nexusGens.set(id, updateResult.value.generation);
    }

    projection.set(id, updated);
    notify({ kind: "patched", agentId: id, fields, entry: updated });

    return { ok: true, value: updated };
  }

  function watch(listener: (event: RegistryEvent) => void): () => void {
    return listeners.subscribe(listener);
  }

  async function dispose(): Promise<void> {
    disposed = true;
    if (pollTimer !== undefined) {
      clearInterval(pollTimer);
      pollTimer = undefined;
    }
    projection.clear();
    nexusGens.clear();
  }

  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      reject(new Error(`createNexusRegistry warmup timed out after ${String(startupTimeoutMs)}ms`));
    }, startupTimeoutMs);
  });
  try {
    await Promise.race([loadProjection(), timeoutPromise]);
  } finally {
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
  }

  if (pollIntervalMs > 0) {
    pollTimer = setInterval(() => {
      void poll();
    }, pollIntervalMs);
  }

  return {
    register,
    deregister,
    lookup,
    list,
    transition,
    patch,
    watch,
    [Symbol.asyncDispose]: dispose,
  };
}
