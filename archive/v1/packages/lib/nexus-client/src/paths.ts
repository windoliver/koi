/**
 * Nexus namespace path builders.
 *
 * Pure functions that produce unified namespace paths for all Nexus-backed
 * storage domains. Each function corresponds to one storage convention from
 * the unified Nexus namespace design (#750).
 *
 * Zero I/O, zero dependencies beyond @koi/core branded types.
 */

import type { AgentGroupId, AgentId, BrickId, NexusPath } from "@koi/core";
import { nexusPath } from "@koi/core";

// ---------------------------------------------------------------------------
// Canonical path segments — single source of truth for domain prefixes.
// namespace.ts (L3) imports these to derive agent-scoped base paths.
// Frozen per #922. Changes require a new issue.
// ---------------------------------------------------------------------------

/**
 * Canonical path segments for each Nexus storage domain.
 * Each segment is relative to the agent root (`agents/{agentId}/`).
 * Stores append resource-specific suffixes to these base segments.
 */
export const SEGMENTS = {
  bricks: "bricks",
  events: "events",
  session: "session",
  memory: "memory/entities",
  snapshots: "snapshots",
  workspace: "workspace",
  mailbox: "mailbox",
} as const;

// ---------------------------------------------------------------------------
// Forge (brick artifacts)
// ---------------------------------------------------------------------------

/** Path to a brick artifact: agents/{agentId}/bricks/{brickId}.json */
export function agentBrickPath(agentId: AgentId, brickId: BrickId): NexusPath {
  return nexusPath(`agents/${agentId}/bricks/${brickId}.json`);
}

/** Glob pattern for all bricks of an agent: agents/{agentId}/bricks/*.json */
export function agentBricksGlob(agentId: AgentId): NexusPath {
  return nexusPath(`agents/${agentId}/bricks/*.json`);
}

/** Path to a global (shared) brick: global/bricks/{brickId}.json */
export function globalBrickPath(brickId: BrickId): NexusPath {
  return nexusPath(`global/bricks/${brickId}.json`);
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/** Path to event stream metadata: agents/{agentId}/events/streams/{streamId}/meta.json */
export function agentEventMetaPath(agentId: AgentId, streamId: string): NexusPath {
  return nexusPath(`agents/${agentId}/events/streams/${streamId}/meta.json`);
}

/** Path to a single event: agents/{agentId}/events/streams/{streamId}/events/{seq}.json */
export function agentEventPath(agentId: AgentId, streamId: string, sequence: string): NexusPath {
  return nexusPath(`agents/${agentId}/events/streams/${streamId}/events/${sequence}.json`);
}

/** Glob for all events in a stream: agents/{agentId}/events/streams/{streamId}/events/*.json */
export function agentEventGlob(agentId: AgentId, streamId: string): NexusPath {
  return nexusPath(`agents/${agentId}/events/streams/${streamId}/events/*.json`);
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

/** Path to a session record: agents/{agentId}/session/records/{sessionId}.json */
export function agentSessionPath(agentId: AgentId, sessionId: string): NexusPath {
  return nexusPath(`agents/${agentId}/session/records/${sessionId}.json`);
}

/** Glob for all session records: agents/{agentId}/session/records/*.json */
export function agentSessionsGlob(agentId: AgentId): NexusPath {
  return nexusPath(`agents/${agentId}/session/records/*.json`);
}

/** Path to a pending frame: agents/{agentId}/session/pending/{sessionId}/{frameId}.json */
export function agentPendingFramePath(
  agentId: AgentId,
  sessionId: string,
  frameId: string,
): NexusPath {
  return nexusPath(`agents/${agentId}/session/pending/${sessionId}/${frameId}.json`);
}

/** Glob for pending frames of a session: agents/{agentId}/session/pending/{sessionId}/*.json */
export function agentPendingFramesGlob(agentId: AgentId, sessionId: string): NexusPath {
  return nexusPath(`agents/${agentId}/session/pending/${sessionId}/*.json`);
}

// ---------------------------------------------------------------------------
// Memory
// ---------------------------------------------------------------------------

/** Path to a memory entity: agents/{agentId}/memory/entities/{slug}.json */
export function agentMemoryPath(agentId: AgentId, slug: string): NexusPath {
  return nexusPath(`agents/${agentId}/memory/entities/${slug}.json`);
}

/** Glob for all memory entities: agents/{agentId}/memory/entities/*.json */
export function agentMemoryGlob(agentId: AgentId): NexusPath {
  return nexusPath(`agents/${agentId}/memory/entities/*.json`);
}

// ---------------------------------------------------------------------------
// Snapshots
// ---------------------------------------------------------------------------

/** Path to a snapshot node: agents/{agentId}/snapshots/{chainId}/{nodeId}.json */
export function agentSnapshotPath(agentId: AgentId, chainId: string, nodeId: string): NexusPath {
  return nexusPath(`agents/${agentId}/snapshots/${chainId}/${nodeId}.json`);
}

/** Glob for all nodes in a chain: agents/{agentId}/snapshots/{chainId}/*.json */
export function agentSnapshotGlob(agentId: AgentId, chainId: string): NexusPath {
  return nexusPath(`agents/${agentId}/snapshots/${chainId}/*.json`);
}

// ---------------------------------------------------------------------------
// Group scratchpad
// ---------------------------------------------------------------------------

/** Path to a group scratchpad entry: groups/{groupId}/scratch/{path} */
export function groupScratchPath(groupId: AgentGroupId, path: string): NexusPath {
  return nexusPath(`groups/${groupId}/scratch/${path}`);
}

/** Glob for all scratchpad entries (recursive): groups/{groupId}/scratch/** */
export function groupScratchGlob(groupId: AgentGroupId): NexusPath {
  return nexusPath(`groups/${groupId}/scratch/**`);
}

// ---------------------------------------------------------------------------
// Subscriptions & dead letters (events subsystem)
// ---------------------------------------------------------------------------

/** Path to a subscription position: agents/{agentId}/events/subscriptions/{name}.json */
export function agentSubscriptionPath(agentId: AgentId, name: string): NexusPath {
  return nexusPath(`agents/${agentId}/events/subscriptions/${name}.json`);
}

/** Path to a dead letter entry: agents/{agentId}/events/dead-letters/{entryId}.json */
export function agentDeadLetterPath(agentId: AgentId, entryId: string): NexusPath {
  return nexusPath(`agents/${agentId}/events/dead-letters/${entryId}.json`);
}

/** Glob for all dead letters: agents/{agentId}/events/dead-letters/*.json */
export function agentDeadLetterGlob(agentId: AgentId): NexusPath {
  return nexusPath(`agents/${agentId}/events/dead-letters/*.json`);
}

// ---------------------------------------------------------------------------
// Workspace (agent-scoped file storage)
// ---------------------------------------------------------------------------

/** Path to a workspace file: agents/{agentId}/workspace/{path} */
export function agentWorkspacePath(agentId: AgentId, path: string): NexusPath {
  return nexusPath(`agents/${agentId}/workspace/${path}`);
}

/** Glob for all workspace files (recursive): agents/{agentId}/workspace/** */
export function agentWorkspaceGlob(agentId: AgentId): NexusPath {
  return nexusPath(`agents/${agentId}/workspace/**`);
}

// ---------------------------------------------------------------------------
// Mailbox — REST+SSE adapter, NOT file-backed.
// See @koi/ipc-nexus for mailbox path conventions.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Gateway (global namespace — shared across gateway instances)
// ---------------------------------------------------------------------------

/** Path to a gateway session record: global/gateway/sessions/{id}.json */
export function gatewaySessionPath(id: string): NexusPath {
  return nexusPath(`global/gateway/sessions/${id}.json`);
}

/** Glob for all gateway sessions: global/gateway/sessions/*.json */
export function gatewaySessionsGlob(): NexusPath {
  return nexusPath("global/gateway/sessions/*.json");
}

/** Path to a gateway node record: global/gateway/nodes/{id}.json */
export function gatewayNodePath(id: string): NexusPath {
  return nexusPath(`global/gateway/nodes/${id}.json`);
}

/** Glob for all gateway nodes: global/gateway/nodes/*.json */
export function gatewayNodesGlob(): NexusPath {
  return nexusPath("global/gateway/nodes/*.json");
}

/** Path to a gateway surface record: global/gateway/surfaces/{id}.json */
export function gatewaySurfacePath(id: string): NexusPath {
  return nexusPath(`global/gateway/surfaces/${id}.json`);
}

/** Glob for all gateway surfaces: global/gateway/surfaces/*.json */
export function gatewaySurfacesGlob(): NexusPath {
  return nexusPath("global/gateway/surfaces/*.json");
}
