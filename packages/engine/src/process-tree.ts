/**
 * Process tree tracker — maintains parent-child relationships from registry events.
 *
 * Watches the AgentRegistry for registration/deregistration events that contain
 * parentId and builds an in-memory tree structure for ancestry queries.
 * Also tracks spawner provenance for lineage queries.
 */

import type { AgentId, AgentRegistry, RegistryEvent } from "@koi/core";

// ---------------------------------------------------------------------------
// Public type
// ---------------------------------------------------------------------------

export interface ProcessTree extends AsyncDisposable {
  /** Get the parent of an agent, or undefined for root agents. */
  readonly parentOf: (id: AgentId) => AgentId | undefined;
  /** Get the direct children of an agent. */
  readonly childrenOf: (id: AgentId) => readonly AgentId[];
  /** Get all descendants of an agent (BFS). */
  readonly descendantsOf: (id: AgentId) => readonly AgentId[];
  /** Get the depth of an agent in the tree (root = 0). */
  readonly depthOf: (id: AgentId) => number;
  /** Total number of tracked agents. */
  readonly size: () => number;
  /**
   * Get the spawner lineage of an agent — walks the spawner chain upward.
   * Returns [spawner, spawner's spawner, ..., root] or empty array for root agents.
   */
  readonly lineage: (id: AgentId) => readonly AgentId[];
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createProcessTree(registry: AgentRegistry): ProcessTree {
  const parentMap = new Map<string, AgentId>();
  const childrenMap = new Map<string, AgentId[]>();
  const spawnerMap = new Map<string, AgentId>();

  const unsubscribe = registry.watch((event: RegistryEvent) => {
    if (event.kind === "registered") {
      const { agentId, parentId } = event.entry;
      if (parentId !== undefined) {
        parentMap.set(agentId, parentId);
        const siblings = childrenMap.get(parentId) ?? [];
        childrenMap.set(parentId, [...siblings, agentId]);
      }
      // Ensure the agent has an entry in childrenMap even if it has no children
      if (!childrenMap.has(agentId)) {
        childrenMap.set(agentId, []);
      }
      // Track spawner provenance
      if (event.entry.spawner !== undefined) {
        spawnerMap.set(agentId, event.entry.spawner);
      }
    }

    if (event.kind === "deregistered") {
      const { agentId } = event;
      const parent = parentMap.get(agentId);
      if (parent !== undefined) {
        const siblings = childrenMap.get(parent);
        if (siblings !== undefined) {
          childrenMap.set(
            parent,
            siblings.filter((id) => id !== agentId),
          );
        }
        parentMap.delete(agentId);
      }
      childrenMap.delete(agentId);
      spawnerMap.delete(agentId);
    }
  });

  function parentOf(id: AgentId): AgentId | undefined {
    return parentMap.get(id);
  }

  function childrenOf(id: AgentId): readonly AgentId[] {
    return childrenMap.get(id) ?? [];
  }

  function descendantsOf(id: AgentId): readonly AgentId[] {
    const result: AgentId[] = [];
    const queue: AgentId[] = [...childrenOf(id)];
    // let justified: index pointer avoids O(n) shift per iteration
    let i = 0;

    while (i < queue.length) {
      // biome-ignore lint/style/noNonNullAssertion: i < queue.length guarantees element exists
      const current = queue[i]!;
      i++;
      result.push(current);
      const children = childrenOf(current);
      for (const child of children) {
        queue.push(child);
      }
    }

    return result;
  }

  function depthOf(id: AgentId): number {
    let depth = 0;
    let current: AgentId | undefined = parentMap.get(id);
    while (current !== undefined) {
      depth++;
      current = parentMap.get(current);
    }
    return depth;
  }

  function size(): number {
    return childrenMap.size;
  }

  function lineage(id: AgentId): readonly AgentId[] {
    const result: AgentId[] = [];
    let current: AgentId | undefined = spawnerMap.get(id);
    while (current !== undefined) {
      result.push(current);
      current = spawnerMap.get(current);
    }
    return result;
  }

  return {
    parentOf,
    childrenOf,
    descendantsOf,
    depthOf,
    size,
    lineage,
    async [Symbol.asyncDispose](): Promise<void> {
      unsubscribe();
      parentMap.clear();
      childrenMap.clear();
      spawnerMap.clear();
    },
  };
}
