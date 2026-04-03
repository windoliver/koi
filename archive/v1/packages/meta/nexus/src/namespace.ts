/**
 * Agent namespace path computation and auto-provisioning.
 *
 * Computes Nexus storage paths scoped by agentId/groupId,
 * then provisions them in parallel via best-effort writes.
 */

import type { AgentId, NexusPath } from "@koi/core";
import { nexusPath } from "@koi/core";
import type { NexusClient } from "@koi/nexus-client";
import { SEGMENTS } from "@koi/nexus-client";

// ---------------------------------------------------------------------------
// Path computation
// ---------------------------------------------------------------------------

/**
 * Computed namespace paths for an agent.
 * Frozen per #922. Changes require a new issue.
 */
export interface AgentNamespace {
  readonly forge: NexusPath;
  readonly events: NexusPath;
  readonly session: NexusPath;
  readonly memory: NexusPath;
  readonly snapshots: NexusPath;
  readonly filesystem: NexusPath;
  readonly mailbox: NexusPath;
}

/** Computed namespace path for a group. */
export interface GroupNamespace {
  readonly scratchpad: NexusPath;
}

/**
 * Computes agent-scoped namespace paths from an agentId.
 * Derives all segments from SEGMENTS (paths.ts) — single source of truth.
 */
export function computeAgentNamespace(agentId: AgentId): AgentNamespace {
  const base = `agents/${agentId as string}`;
  return {
    forge: nexusPath(`${base}/${SEGMENTS.bricks}`),
    events: nexusPath(`${base}/${SEGMENTS.events}`),
    session: nexusPath(`${base}/${SEGMENTS.session}`),
    memory: nexusPath(`${base}/${SEGMENTS.memory}`),
    snapshots: nexusPath(`${base}/${SEGMENTS.snapshots}`),
    filesystem: nexusPath(`${base}/${SEGMENTS.workspace}`),
    mailbox: nexusPath(`${base}/${SEGMENTS.mailbox}`),
  };
}

/** Computes group-scoped namespace paths from a groupId. */
export function computeGroupNamespace(groupId: string): GroupNamespace {
  return {
    scratchpad: nexusPath(`groups/${groupId}/scratch`),
  };
}

// ---------------------------------------------------------------------------
// Auto-provisioning
// ---------------------------------------------------------------------------

/** Marker file content written during provisioning. */
const MARKER_CONTENT = "";

/**
 * Ensures namespace directories exist by writing a `.koi` marker file
 * to each path. Best-effort: failures are logged, never thrown.
 */
export async function ensureNamespace(
  client: NexusClient,
  paths: readonly (string | NexusPath)[],
): Promise<void> {
  const results = await Promise.allSettled(
    paths.map((path) =>
      client.rpc("write", {
        path: `${path}/.koi`,
        content: MARKER_CONTENT,
        createDirectories: true,
      }),
    ),
  );

  for (const [i, result] of results.entries()) {
    if (result.status === "rejected") {
      console.warn(
        `[nexus] namespace provisioning failed for ${paths[i]}: ${String(result.reason)}`,
      );
    }
  }
}
