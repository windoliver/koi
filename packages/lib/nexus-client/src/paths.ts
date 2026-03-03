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

/** Path to event stream metadata: agents/{agentId}/events/{streamId}/meta.json */
export function agentEventMetaPath(agentId: AgentId, streamId: string): NexusPath {
  return nexusPath(`agents/${agentId}/events/${streamId}/meta.json`);
}

/** Path to a single event: agents/{agentId}/events/{streamId}/events/{seq}.json */
export function agentEventPath(agentId: AgentId, streamId: string, sequence: string): NexusPath {
  return nexusPath(`agents/${agentId}/events/${streamId}/events/${sequence}.json`);
}

/** Glob for all events in a stream: agents/{agentId}/events/{streamId}/events/*.json */
export function agentEventGlob(agentId: AgentId, streamId: string): NexusPath {
  return nexusPath(`agents/${agentId}/events/${streamId}/events/*.json`);
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

/** Path to session record: agents/{agentId}/session/record.json */
export function agentSessionPath(agentId: AgentId): NexusPath {
  return nexusPath(`agents/${agentId}/session/record.json`);
}

/** Path to a pending frame: agents/{agentId}/session/pending-frames/{frameId}.json */
export function agentPendingFramePath(agentId: AgentId, frameId: string): NexusPath {
  return nexusPath(`agents/${agentId}/session/pending-frames/${frameId}.json`);
}

/** Glob for pending frames: agents/{agentId}/session/pending-frames/*.json */
export function agentPendingFramesGlob(agentId: AgentId): NexusPath {
  return nexusPath(`agents/${agentId}/session/pending-frames/*.json`);
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

/** Glob for all scratchpad entries: groups/{groupId}/scratch/* */
export function groupScratchGlob(groupId: AgentGroupId): NexusPath {
  return nexusPath(`groups/${groupId}/scratch/*`);
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
