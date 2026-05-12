/**
 * Thin RPC helpers over `NexusTransport.call`.
 *
 * The transport layer already maps JSON-RPC errors to KoiError and returns
 * `Result<T, KoiError>`, so these helpers are just typed method-name wrappers.
 */

import type { KoiError, Result } from "@koi/core";
import type { NexusTransport } from "@koi/nexus-client";

/** Shape of a Nexus agent record returned by list/get calls. */
export interface NexusAgent {
  readonly agent_id: string;
  readonly name?: string;
  readonly state: string;
  readonly zone_id?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly generation?: number;
}

export function nexusRegisterAgent(
  transport: NexusTransport,
  params: {
    readonly agent_id: string;
    readonly name?: string;
    readonly zone_id?: string;
    readonly metadata?: Readonly<Record<string, unknown>>;
  },
): Promise<Result<NexusAgent, KoiError>> {
  return transport.call<NexusAgent>("register_agent", params);
}

export function nexusDeleteAgent(
  transport: NexusTransport,
  id: string,
): Promise<Result<unknown, KoiError>> {
  return transport.call("delete_agent", { agent_id: id });
}

export function nexusTransition(
  transport: NexusTransport,
  id: string,
  targetState: string,
  expectedGeneration: number,
): Promise<Result<NexusAgent, KoiError>> {
  return transport.call<NexusAgent>("agent_transition", {
    agent_id: id,
    target_state: targetState,
    expected_generation: expectedGeneration,
  });
}

export function nexusListAgents(
  transport: NexusTransport,
  zoneId?: string,
): Promise<Result<readonly NexusAgent[], KoiError>> {
  const method = zoneId !== undefined ? "agent_list_by_zone" : "list_agents";
  const params = zoneId !== undefined ? { zone_id: zoneId } : {};
  return transport.call<readonly NexusAgent[]>(method, params);
}

export function nexusGetAgent(
  transport: NexusTransport,
  id: string,
): Promise<Result<NexusAgent, KoiError>> {
  return transport.call<NexusAgent>("get_agent", { agent_id: id });
}

export function nexusUpdateMetadata(
  transport: NexusTransport,
  id: string,
  metadata: Readonly<Record<string, unknown>>,
  expectedGeneration?: number,
): Promise<Result<NexusAgent, KoiError>> {
  return transport.call<NexusAgent>("update_agent_metadata", {
    agent_id: id,
    metadata,
    ...(expectedGeneration !== undefined ? { expected_generation: expectedGeneration } : {}),
  });
}
