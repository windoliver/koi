/**
 * Nexus-backed AgentRegistry implementation.
 *
 * Uses Nexus as the authoritative store for agent state. Maintains a local
 * in-memory projection for fast reads, synchronized via periodic polling.
 * Watch events are emitted both from local mutations and from poll diffs.
 *
 * Dual-generation model: Koi generation (CAS for callers) is tracked in
 * the local projection. Nexus generation (CAS for server) is tracked
 * separately in `nexusGens` and used for Nexus RPC calls.
 *
 * L2 package — imports only from @koi/core (L0).
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
} from "@koi/core";
import { agentId, matchesFilter, VALID_TRANSITIONS } from "@koi/core";
import type { NexusRegistryConfig } from "./config.js";
import { DEFAULT_NEXUS_REGISTRY_CONFIG } from "./config.js";
import type { NexusAgent } from "./nexus-client.js";
import {
  nexusDeleteAgent,
  nexusGetAgent,
  nexusListAgents,
  nexusRegisterAgent,
  nexusTransition,
  nexusUpdateMetadata,
} from "./nexus-client.js";
import { decodeKoiStatus, encodeKoiStatus, mapKoiToNexus, mapNexusToKoi } from "./state-mapping.js";

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a Nexus-backed AgentRegistry.
 *
 * Performs eager warmup by listing all agents from Nexus at startup.
 * Starts a poll timer to keep the local projection in sync.
 */
export async function createNexusRegistry(config: NexusRegistryConfig): Promise<AgentRegistry> {
  const maxEntries = config.maxEntries ?? DEFAULT_NEXUS_REGISTRY_CONFIG.maxEntries;
  const pollIntervalMs = config.pollIntervalMs ?? DEFAULT_NEXUS_REGISTRY_CONFIG.pollIntervalMs;

  // Mutable internal state
  const projection = new Map<string, RegistryEntry>();
  /** Nexus-side generation per agent — separate from Koi generation. */
  const nexusGens = new Map<string, number>();
  // let: replaced on watch/unsubscribe (immutable-set pattern)
  let listeners: ReadonlySet<(event: RegistryEvent) => void> = new Set();
  // let: poll timer handle, cleared on dispose
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  // let: disposed flag to prevent operations after cleanup
  let disposed = false;

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  function notify(event: RegistryEvent): void {
    for (const listener of listeners) {
      listener(event);
    }
  }

  /** Map a NexusAgent to a RegistryEntry using metadata for full status. */
  function mapNexusAgentToEntry(agent: NexusAgent): RegistryEntry {
    const metadata = agent.metadata ?? {};
    const koiStatus = decodeKoiStatus(metadata);
    const phase = koiStatus?.phase ?? mapNexusToKoi(agent.state, metadata);

    const status: AgentStatus = koiStatus ?? {
      phase,
      generation: agent.generation ?? 0,
      conditions: [],
      lastTransitionAt: Date.now(),
    };

    const base: RegistryEntry = {
      agentId: agentId(agent.agent_id),
      status,
      agentType: (metadata.agentType as "copilot" | "worker") ?? "worker",
      metadata,
      registeredAt: (metadata.registeredAt as number) ?? Date.now(),
      priority: (metadata.priority as number) ?? 10,
    };

    // Conditionally add optional fields (exactOptionalPropertyTypes compliance)
    const parentId = typeof metadata.parentId === "string" ? agentId(metadata.parentId) : undefined;
    const spawner = typeof metadata.spawner === "string" ? agentId(metadata.spawner) : undefined;

    if (parentId !== undefined && spawner !== undefined) {
      return { ...base, parentId, spawner };
    }
    if (parentId !== undefined) {
      return { ...base, parentId };
    }
    if (spawner !== undefined) {
      return { ...base, spawner };
    }
    return base;
  }

  /** Load all agents from Nexus into the local projection. */
  async function loadProjection(): Promise<void> {
    const listResult = await nexusListAgents(config, config.zoneId);
    if (!listResult.ok) {
      throw new Error(
        `Failed to load agents from Nexus during startup: ${listResult.error.message}`,
        { cause: listResult.error },
      );
    }

    projection.clear();
    nexusGens.clear();

    for (const nexusAgent of listResult.value) {
      if (projection.size >= maxEntries) break;

      // Fetch full agent details (list may not include metadata)
      const detailResult = await nexusGetAgent(config, nexusAgent.agent_id);
      if (detailResult.ok) {
        const entry = mapNexusAgentToEntry(detailResult.value);
        projection.set(entry.agentId, entry);
        nexusGens.set(entry.agentId, detailResult.value.generation ?? 0);
      }
    }
  }

  /** Poll Nexus for changes and diff against the local projection. */
  async function poll(): Promise<void> {
    if (disposed) return;

    const listResult = await nexusListAgents(config, config.zoneId);
    if (!listResult.ok) return; // Silently skip failed polls

    const remoteIds = new Set<string>();

    for (const nexusAgent of listResult.value) {
      remoteIds.add(nexusAgent.agent_id);
      const id = agentId(nexusAgent.agent_id);
      const existing = projection.get(id);

      // Check if Nexus generation changed or agent is new
      const remoteGen = nexusAgent.generation ?? 0;
      const localNexusGen = nexusGens.get(id) ?? -1;

      if (localNexusGen !== remoteGen || existing === undefined) {
        // Fetch full details for changed/new agents
        const detailResult = await nexusGetAgent(config, nexusAgent.agent_id);
        if (!detailResult.ok) continue;

        const entry = mapNexusAgentToEntry(detailResult.value);

        if (projection.size >= maxEntries && existing === undefined) continue;

        projection.set(id, entry);
        nexusGens.set(id, detailResult.value.generation ?? 0);

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
    }

    // Detect removed agents
    for (const [id] of projection) {
      if (!remoteIds.has(id)) {
        projection.delete(id);
        nexusGens.delete(id);
        notify({ kind: "deregistered", agentId: agentId(id) });
      }
    }
  }

  // -------------------------------------------------------------------------
  // AgentRegistry implementation
  // -------------------------------------------------------------------------

  async function register(entry: RegistryEntry): Promise<RegistryEntry> {
    const koiMetadata = encodeKoiStatus(entry.status);
    const mergedMetadata: Record<string, unknown> = {
      ...entry.metadata,
      ...koiMetadata,
      agentType: entry.agentType,
      registeredAt: entry.registeredAt,
      priority: entry.priority,
    };

    if (entry.parentId !== undefined) {
      mergedMetadata.parentId = entry.parentId;
    }
    if (entry.spawner !== undefined) {
      mergedMetadata.spawner = entry.spawner;
    }

    const registerResult = await nexusRegisterAgent(config, {
      agent_id: entry.agentId,
      name: entry.agentId,
      metadata: mergedMetadata,
      ...(config.zoneId !== undefined ? { zone_id: config.zoneId } : {}),
    });

    if (!registerResult.ok) {
      throw new Error(
        `Failed to register agent ${entry.agentId} in Nexus: ${registerResult.error.message}`,
        { cause: registerResult.error },
      );
    }

    // Transition from UNKNOWN to the appropriate Nexus state.
    // Track Nexus generation as it advances through setup transitions.
    // let: advances through setup transitions
    let currentNexusGen = registerResult.value.generation ?? 0;

    const targetNexusState = mapKoiToNexus(entry.status.phase);
    // All Koi states map to a non-UNKNOWN state, so always transition to CONNECTED first
    const connectedResult = await nexusTransition(
      config,
      entry.agentId,
      "CONNECTED",
      currentNexusGen,
    );
    if (connectedResult.ok) {
      currentNexusGen = connectedResult.value.generation ?? currentNexusGen + 1;
    }

    // If target is not CONNECTED, do a second transition
    if (targetNexusState !== "CONNECTED" && connectedResult.ok) {
      const targetResult = await nexusTransition(
        config,
        entry.agentId,
        targetNexusState,
        currentNexusGen,
      );
      if (targetResult.ok) {
        currentNexusGen = targetResult.value.generation ?? currentNexusGen + 1;
      }
    }

    // Store in local projection with Koi generation (from entry)
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

    await nexusDeleteAgent(config, id);

    projection.delete(id);
    nexusGens.delete(id);
    notify({ kind: "deregistered", agentId: id });
    return true;
  }

  function lookup(id: AgentId): RegistryEntry | undefined {
    return projection.get(id);
  }

  function list(filter?: RegistryFilter): readonly RegistryEntry[] {
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

    // CAS check: Koi generation must match
    if (current.status.generation !== expectedGeneration) {
      return {
        ok: false,
        error: {
          code: "CONFLICT",
          message: `Stale generation: expected ${String(expectedGeneration)}, current is ${String(current.status.generation)}`,
          retryable: true,
        },
      };
    }

    // Validate transition edge
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

    // Call Nexus transition using Nexus generation (not Koi generation)
    const targetNexusState = mapKoiToNexus(targetPhase);
    const currentNexusGen = nexusGens.get(id) ?? 0;
    const nexusResult = await nexusTransition(config, id, targetNexusState, currentNexusGen);

    if (!nexusResult.ok) {
      // Map Nexus CONFLICT to registry CONFLICT
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

    // Update tracked Nexus generation
    nexusGens.set(id, nexusResult.value.generation ?? currentNexusGen + 1);

    // Build new Koi status
    const newStatus: AgentStatus = {
      phase: targetPhase,
      generation: current.status.generation + 1,
      conditions: [...current.status.conditions],
      reason,
      lastTransitionAt: Date.now(),
    };

    // Update Nexus metadata with full Koi status
    const statusMetadata = encodeKoiStatus(newStatus);
    const updateResult = await nexusUpdateMetadata(config, id, {
      ...current.metadata,
      ...statusMetadata,
    });

    // Update Nexus gen after metadata update if it advanced
    if (updateResult.ok && updateResult.value.generation !== undefined) {
      nexusGens.set(id, updateResult.value.generation);
    }

    // Update local projection
    const updated: RegistryEntry = {
      ...current,
      status: newStatus,
    };
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

    // Build updated entry (copy-on-write, only non-undefined fields)
    const updated: RegistryEntry = {
      ...current,
      ...(fields.priority !== undefined ? { priority: fields.priority } : {}),
      ...(fields.metadata !== undefined ? { metadata: fields.metadata } : {}),
      ...(fields.zoneId !== undefined ? { zoneId: fields.zoneId } : {}),
    };

    // Persist patched fields to Nexus metadata
    const nexusMeta: Record<string, unknown> = { ...current.metadata };
    if (fields.priority !== undefined) {
      nexusMeta.priority = fields.priority;
    }
    if (fields.metadata !== undefined) {
      Object.assign(nexusMeta, fields.metadata);
    }

    const updateResult = await nexusUpdateMetadata(config, id, nexusMeta);
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

    // Update Nexus gen after metadata update
    if (updateResult.value.generation !== undefined) {
      nexusGens.set(id, updateResult.value.generation);
    }

    // Update local projection
    projection.set(id, updated);

    notify({ kind: "patched", agentId: id, fields, entry: updated });

    return { ok: true, value: updated };
  }

  function watch(listener: (event: RegistryEvent) => void): () => void {
    listeners = new Set([...listeners, listener]);
    return () => {
      listeners = new Set([...listeners].filter((l) => l !== listener));
    };
  }

  async function dispose(): Promise<void> {
    disposed = true;
    if (pollTimer !== undefined) {
      clearInterval(pollTimer);
      pollTimer = undefined;
    }
    projection.clear();
    nexusGens.clear();
    listeners = new Set();
  }

  // -------------------------------------------------------------------------
  // Startup: load projection + start poll timer
  // -------------------------------------------------------------------------

  await loadProjection();

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
