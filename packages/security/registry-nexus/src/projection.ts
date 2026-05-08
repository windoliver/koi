/**
 * Helpers for projecting Nexus agent records into immutable RegistryEntry
 * objects. Extracted from nexus-registry.ts to keep that file under the
 * monorepo's complexity ceiling.
 */

import type { AgentStatus, RegistryEntry } from "@koi/core";
import { agentGroupId, agentId, zoneId } from "@koi/core";
import type { NexusAgent } from "./nexus-rpc.js";
import { decodeKoiStatus, mapKoiToNexus, mapNexusToKoi } from "./state-mapping.js";

/**
 * Metadata keys owned by the registry adapter. Callers must not overwrite
 * these via patch() — they encode lifecycle and identity that the adapter
 * treats as authoritative when re-hydrating from Nexus, and accepting
 * caller writes would let `metadata.koi:terminated = true` (or a forged
 * agentType/parentId/etc.) cross the user-data → registry-state trust
 * boundary on the next refetch.
 */
export const RESERVED_METADATA_KEYS: ReadonlySet<string> = new Set([
  "koi:status",
  "koi:terminated",
  "agentType",
  "registeredAt",
  "priority",
  "parentId",
  "spawner",
  "groupId",
  "zoneId",
]);

function deepFreeze(value: unknown): void {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return;
  Object.freeze(value);
  for (const key of Object.keys(value)) {
    deepFreeze((value as Record<string, unknown>)[key]);
  }
}

/**
 * Deep-freeze a registry entry before storing or returning it. TypeScript
 * `readonly` is compile-only; without runtime freezing, callers (including
 * watch listeners) could mutate `entry.metadata` in place. Later
 * `transition()` / `patch()` rebuild outbound Nexus payloads from
 * `current.metadata`, so an in-process mutation could inject reserved
 * keys (`koi:terminated`, `agentType`, etc.) that bypass the validation
 * path in `patch({ metadata })` and corrupt lifecycle/identity state.
 */
export function freezeEntry(entry: RegistryEntry): RegistryEntry {
  deepFreeze(entry.metadata);
  deepFreeze(entry.status);
  return Object.freeze(entry);
}

function resolveAgentStatus(agent: NexusAgent): AgentStatus {
  const metadata = agent.metadata ?? {};
  const koiStatus = decodeKoiStatus(metadata);
  const remotePhase = mapNexusToKoi(agent.state, metadata);

  // Nexus SUSPENDED is lossy: both Koi suspended and terminated map to it.
  // Require that metadata.koi:terminated explicitly match the encoded phase
  // before trusting the blob in this ambiguous case.
  const remoteIsAmbiguousSuspended = agent.state === "SUSPENDED";
  const terminatedFlag = metadata["koi:terminated"] === true;
  const ambiguityResolved =
    !remoteIsAmbiguousSuspended ||
    (koiStatus?.phase === "terminated" && terminatedFlag) ||
    (koiStatus?.phase === "suspended" && !terminatedFlag);

  // Trust koi:status when it round-trips through the same Nexus state.
  // CONNECTED admits both `created` and `running`, IDLE admits both
  // `waiting` and `idle`. Without this a `created` agent would be
  // observable as `running` on every refetch — losing the startup
  // transition event ChildHandle/spawn-child rely on.
  const koiStatusRoundTrips =
    koiStatus !== undefined && mapKoiToNexus(koiStatus.phase) === agent.state;
  const trusted =
    koiStatus !== undefined && koiStatusRoundTrips && ambiguityResolved ? koiStatus : undefined;

  return (
    trusted ?? {
      phase: remotePhase,
      generation: agent.generation ?? 0,
      conditions: [],
      lastTransitionAt: Date.now(),
    }
  );
}

export function mapNexusAgentToEntry(agent: NexusAgent): RegistryEntry {
  const metadata = agent.metadata ?? {};
  const status = resolveAgentStatus(agent);

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
