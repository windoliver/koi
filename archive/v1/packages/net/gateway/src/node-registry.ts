/**
 * Node registration and health tracking for connected compute nodes.
 * Maintains an inverted tool index for O(1) tool-to-node lookups.
 *
 * Interfaces re-exported from @koi/gateway-types for backward compatibility.
 */

import type { AdvertisedTool, CapacityReport, KoiError, Result } from "@koi/core";
import { conflict, notFound, validation } from "@koi/core";

// Re-export interfaces from @koi/gateway-types
export type { AdvertisedTool, CapacityReport } from "@koi/core";
export type { NodeRegistry, NodeRegistryEvent, RegisteredNode } from "@koi/gateway-types";

// ---------------------------------------------------------------------------
// In-memory implementation
// ---------------------------------------------------------------------------

export function createInMemoryNodeRegistry(): import("@koi/gateway-types").NodeRegistry {
  const nodeMap = new Map<string, import("@koi/gateway-types").RegisteredNode>();
  /** Inverted index: tool name → set of nodeIds advertising that tool. */
  const toolIndex = new Map<string, Set<string>>();

  function addToToolIndex(nodeId: string, tools: readonly AdvertisedTool[]): void {
    for (const tool of tools) {
      let ids = toolIndex.get(tool.name);
      if (ids === undefined) {
        ids = new Set();
        toolIndex.set(tool.name, ids);
      }
      ids.add(nodeId);
    }
  }

  function removeFromToolIndex(nodeId: string, tools: readonly AdvertisedTool[]): void {
    for (const tool of tools) {
      const ids = toolIndex.get(tool.name);
      if (ids !== undefined) {
        ids.delete(nodeId);
        if (ids.size === 0) {
          toolIndex.delete(tool.name);
        }
      }
    }
  }

  return {
    register(node: import("@koi/gateway-types").RegisteredNode): Result<void, KoiError> {
      if (node.nodeId.length === 0) {
        return { ok: false, error: validation("nodeId must not be empty") };
      }
      if (nodeMap.has(node.nodeId)) {
        return {
          ok: false,
          error: conflict(node.nodeId, `Node already registered: ${node.nodeId}`),
        };
      }
      nodeMap.set(node.nodeId, node);
      addToToolIndex(node.nodeId, node.tools);
      return { ok: true, value: undefined };
    },

    deregister(nodeId: string): Result<boolean, KoiError> {
      const existing = nodeMap.get(nodeId);
      if (existing === undefined) {
        return { ok: true, value: false };
      }
      removeFromToolIndex(nodeId, existing.tools);
      nodeMap.delete(nodeId);
      return { ok: true, value: true };
    },

    lookup(nodeId: string): import("@koi/gateway-types").RegisteredNode | undefined {
      return nodeMap.get(nodeId);
    },

    findByTool(toolName: string): readonly import("@koi/gateway-types").RegisteredNode[] {
      const ids = toolIndex.get(toolName);
      if (ids === undefined) return [];
      const result: import("@koi/gateway-types").RegisteredNode[] = [];
      for (const id of ids) {
        const node = nodeMap.get(id);
        if (node !== undefined) {
          result.push(node);
        }
      }
      return result;
    },

    nodes(): ReadonlyMap<string, import("@koi/gateway-types").RegisteredNode> {
      return nodeMap;
    },

    size(): number {
      return nodeMap.size;
    },

    updateHeartbeat(nodeId: string): Result<void, KoiError> {
      const existing = nodeMap.get(nodeId);
      if (existing === undefined) {
        return {
          ok: false,
          error: notFound(nodeId, `Node not found: ${nodeId}`),
        };
      }
      nodeMap.set(nodeId, { ...existing, lastHeartbeat: Date.now() });
      return { ok: true, value: undefined };
    },

    updateCapacity(nodeId: string, capacity: CapacityReport): Result<void, KoiError> {
      const existing = nodeMap.get(nodeId);
      if (existing === undefined) {
        return {
          ok: false,
          error: notFound(nodeId, `Node not found: ${nodeId}`),
        };
      }
      nodeMap.set(nodeId, { ...existing, capacity });
      return { ok: true, value: undefined };
    },

    updateTools(
      nodeId: string,
      added: readonly AdvertisedTool[],
      removed: readonly string[],
    ): Result<void, KoiError> {
      const existing = nodeMap.get(nodeId);
      if (existing === undefined) {
        return {
          ok: false,
          error: notFound(nodeId, `Node not found: ${nodeId}`),
        };
      }

      // Remove tools from index by name
      const removedSet = new Set(removed);
      const removedTools = existing.tools.filter((t) => removedSet.has(t.name));
      removeFromToolIndex(nodeId, removedTools);

      // Add new tools to index
      addToToolIndex(nodeId, added);

      // Build new tools array: keep non-removed, append added (immutable)
      const keptTools = existing.tools.filter((t) => !removedSet.has(t.name));
      const newTools = [...keptTools, ...added];

      nodeMap.set(nodeId, { ...existing, tools: newTools });
      return { ok: true, value: undefined };
    },
  };
}
