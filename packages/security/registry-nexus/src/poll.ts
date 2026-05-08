/**
 * Poll loop logic — extracted to keep nexus-registry.ts under the
 * monorepo's complexity ceiling. The function mutates the maps it is
 * given (projection, nexusGens, stale, perAgentGetFailures) and may set
 * `ctx.broken` to a non-empty string to mark the registry unhealthy.
 */

import type {
  AgentId,
  KoiError,
  PatchableRegistryFields,
  RegistryEntry,
  RegistryEvent,
} from "@koi/core";
import { agentId } from "@koi/core";
import type { NexusTransport } from "@koi/nexus-client";
import { nexusGetAgent, nexusListAgents } from "./nexus-rpc.js";
import { freezeEntry, mapNexusAgentToEntry } from "./projection.js";

const MAX_PER_AGENT_GET_FAILURES = 3;

export interface PollContext {
  readonly transport: NexusTransport;
  readonly zoneId: string | undefined;
  readonly maxEntries: number;
  readonly projection: Map<AgentId, RegistryEntry>;
  readonly nexusGens: Map<AgentId, number>;
  readonly stale: Set<AgentId>;
  readonly perAgentGetFailures: Map<AgentId, number>;
  readonly notify: (event: RegistryEvent) => void;
  readonly recordPollFailure: (reason: string, err: KoiError) => void;
  /** Set to a non-empty string to mark the registry permanently broken. */
  setBroken: (msg: string) => void;
  /** Returns true if poll should bail (registry disposed). */
  readonly isDisposed: () => boolean;
  /** Called once at the end of each tick with per-tick failure metrics. */
  readonly onPollComplete: (perTickGetFailures: number, remoteAgentCount: number) => void;
}

export async function runPoll(ctx: PollContext): Promise<void> {
  if (ctx.isDisposed()) return;

  const listResult = await nexusListAgents(ctx.transport, ctx.zoneId);
  if (!listResult.ok) {
    ctx.recordPollFailure("list_agents", listResult.error);
    return;
  }

  const remoteIds = new Set<string>();
  let perTickGetFailures = 0;

  for (const nexusAgent of listResult.value) {
    remoteIds.add(nexusAgent.agent_id);
    const result = await processRemoteAgent(ctx, nexusAgent);
    if (result === "capacity") return;
    if (result === "get_failed") perTickGetFailures += 1;
  }

  // Sweep deregistered: anything in projection that wasn't seen in the list.
  for (const [id] of ctx.projection) {
    if (!remoteIds.has(id)) {
      ctx.projection.delete(id);
      ctx.nexusGens.delete(id);
      ctx.stale.delete(id);
      ctx.perAgentGetFailures.delete(id);
      ctx.notify({ kind: "deregistered", agentId: id });
    }
  }

  ctx.onPollComplete(perTickGetFailures, listResult.value.length);
}

type ProcessResult = "skipped" | "applied" | "get_failed" | "map_failed" | "capacity";

async function processRemoteAgent(
  ctx: PollContext,
  nexusAgent: { agent_id: string; generation?: number },
): Promise<ProcessResult> {
  const id = agentId(nexusAgent.agent_id);
  const existing = ctx.projection.get(id);
  const remoteGen = nexusAgent.generation ?? 0;
  const localNexusGen = ctx.nexusGens.get(id) ?? -1;

  // Force hydration for tombstoned entries even if the generation hasn't
  // changed — otherwise a transient outage that produced a stale tombstone
  // keeps the agent permanently invisible until an unrelated remote
  // mutation bumps its generation.
  if (localNexusGen === remoteGen && existing !== undefined && !ctx.stale.has(id)) return "skipped";

  const detail = await nexusGetAgent(ctx.transport, nexusAgent.agent_id);
  if (!detail.ok) {
    handleGetFailure(
      ctx,
      id,
      nexusAgent.agent_id,
      existing,
      remoteGen,
      localNexusGen,
      detail.error,
    );
    return "get_failed";
  }
  ctx.perAgentGetFailures.delete(id);

  if (ctx.projection.size >= ctx.maxEntries && existing === undefined) {
    ctx.setBroken(
      `poll observed remote agent ${nexusAgent.agent_id} but projection is at capacity (${String(ctx.maxEntries)}); raise maxEntries or scale out`,
    );
    return "capacity";
  }

  let entry: RegistryEntry;
  try {
    entry = freezeEntry(mapNexusAgentToEntry(detail.value));
  } catch (err) {
    const prev = ctx.perAgentGetFailures.get(id) ?? 0;
    ctx.perAgentGetFailures.set(id, prev + 1);
    console.warn(
      `[registry-nexus] failed to map Nexus agent ${nexusAgent.agent_id}: ${err instanceof Error ? err.message : String(err)}`,
    );
    if ((ctx.perAgentGetFailures.get(id) ?? 0) >= MAX_PER_AGENT_GET_FAILURES) ctx.stale.add(id);
    return "map_failed";
  }

  ctx.projection.set(id, entry);
  ctx.nexusGens.set(id, detail.value.generation ?? 0);
  ctx.stale.delete(id);
  notifyDelta(ctx, id, existing, entry);
  return "applied";
}

function handleGetFailure(
  ctx: PollContext,
  id: AgentId,
  rawId: string,
  existing: RegistryEntry | undefined,
  remoteGen: number,
  localNexusGen: number,
  err: KoiError,
): void {
  const prev = ctx.perAgentGetFailures.get(id) ?? 0;
  const next = prev + 1;
  ctx.perAgentGetFailures.set(id, next);
  console.warn(
    `[registry-nexus] poll get_agent ${rawId} failed (${String(next)}/${String(MAX_PER_AGENT_GET_FAILURES)}): ${err.message}`,
  );
  // Fail closed immediately when the remote generation has advanced.
  const generationAdvanced = existing !== undefined && remoteGen !== localNexusGen;
  if (generationAdvanced || next >= MAX_PER_AGENT_GET_FAILURES) {
    ctx.stale.add(id);
    console.error(
      `[registry-nexus] tombstoning ${rawId} (${generationAdvanced ? "generation advanced; local mirror stale" : `${String(MAX_PER_AGENT_GET_FAILURES)} consecutive get_agent failures`}) — reads will return undefined until refetch succeeds`,
    );
  }
}

function notifyDelta(
  ctx: PollContext,
  id: AgentId,
  existing: RegistryEntry | undefined,
  entry: RegistryEntry,
): void {
  if (existing === undefined) {
    ctx.notify({ kind: "registered", entry });
    return;
  }
  if (existing.status.phase !== entry.status.phase) {
    ctx.notify({
      kind: "transitioned",
      agentId: id,
      from: existing.status.phase,
      to: entry.status.phase,
      generation: entry.status.generation,
      reason: entry.status.reason ?? { kind: "assembly_complete" },
    });
    return;
  }
  // Phase unchanged but other mutable fields may have shifted.
  const priorityChanged = existing.priority !== entry.priority;
  const metadataChanged = JSON.stringify(existing.metadata) !== JSON.stringify(entry.metadata);
  if (priorityChanged || metadataChanged) {
    const fields: PatchableRegistryFields = {
      ...(priorityChanged ? { priority: entry.priority } : {}),
      ...(metadataChanged ? { metadata: entry.metadata } : {}),
    };
    ctx.notify({ kind: "patched", agentId: id, fields, entry });
  }
}
