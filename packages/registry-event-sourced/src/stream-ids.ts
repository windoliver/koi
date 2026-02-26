/**
 * Stream ID helpers for the event-sourced registry.
 *
 * Each agent has its own event stream: "agent:<agentId>".
 * A shared index stream tracks which agents exist.
 */

import type { AgentId } from "@koi/core";
import { agentId } from "@koi/core";

const AGENT_STREAM_PREFIX = "agent:";

/** The shared index stream that tracks agent registration/deregistration. */
export const REGISTRY_INDEX_STREAM = "agent-registry-index";

/** Create a per-agent stream ID: "agent:<agentId>". */
export function agentStreamId(id: AgentId): string {
  return `${AGENT_STREAM_PREFIX}${id}`;
}

/** Parse an agent ID from a stream ID. Returns undefined if not a valid agent stream. */
export function parseAgentStreamId(streamId: string): AgentId | undefined {
  if (!streamId.startsWith(AGENT_STREAM_PREFIX)) return undefined;
  const raw = streamId.slice(AGENT_STREAM_PREFIX.length);
  if (raw === "") return undefined;
  return agentId(raw);
}
