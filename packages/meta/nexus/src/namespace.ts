/**
 * Agent namespace path computation and auto-provisioning.
 *
 * Computes Nexus storage paths scoped by agentId/groupId,
 * then provisions them in parallel via best-effort writes.
 */

import type { AgentId } from "@koi/core";
import type { NexusClient } from "@koi/nexus-client";

// ---------------------------------------------------------------------------
// Path computation
// ---------------------------------------------------------------------------

/** Computed namespace paths for an agent. */
export interface AgentNamespace {
  readonly forge: string;
  readonly events: string;
  readonly session: string;
  readonly memory: string;
  readonly snapshots: string;
  readonly filesystem: string;
  readonly mailbox: string;
}

/** Computed namespace path for a group. */
export interface GroupNamespace {
  readonly scratchpad: string;
}

/** Computes agent-scoped namespace paths from an agentId. */
export function computeAgentNamespace(agentId: AgentId): AgentNamespace {
  const base = `/agents/${agentId as string}`;
  return {
    forge: `${base}/forge/bricks`,
    events: `${base}/events`,
    session: `${base}/sessions`,
    memory: `${base}/memory`,
    snapshots: `${base}/snapshots`,
    filesystem: `${base}/workspace`,
    mailbox: `${base}/mailbox`,
  };
}

/** Computes group-scoped namespace paths from a groupId. */
export function computeGroupNamespace(groupId: string): GroupNamespace {
  return {
    scratchpad: `/groups/${groupId}/scratch`,
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
  paths: readonly string[],
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
