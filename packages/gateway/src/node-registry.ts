/**
 * Node registration and health tracking for connected compute nodes.
 * Maintains an inverted tool index for O(1) tool-to-node lookups.
 *
 * Internal to @koi/gateway (L2) — not an L0 contract.
 */

import type { KoiError, Result } from "@koi/core";
import { conflict, notFound, validation } from "@koi/core";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AdvertisedTool {
  readonly name: string;
  readonly description?: string | undefined;
  readonly schema?: Readonly<Record<string, unknown>> | undefined;
}

export interface CapacityReport {
  readonly current: number;
  readonly max: number;
  readonly available: number;
}

export interface RegisteredNode {
  readonly nodeId: string;
  readonly mode: "full" | "thin";
  readonly tools: readonly AdvertisedTool[];
  readonly capacity: CapacityReport;
  readonly connectedAt: number;
  readonly lastHeartbeat: number;
  readonly connId: string;
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export type NodeRegistryEvent =
  | { readonly kind: "registered"; readonly node: RegisteredNode }
  | { readonly kind: "deregistered"; readonly nodeId: string }
  | { readonly kind: "heartbeat"; readonly nodeId: string }
  | {
      readonly kind: "capacity_updated";
      readonly nodeId: string;
      readonly capacity: CapacityReport;
    };

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

export interface NodeRegistry {
  readonly register: (node: RegisteredNode) => Result<void, KoiError>;
  readonly deregister: (nodeId: string) => Result<boolean, KoiError>;
  readonly lookup: (nodeId: string) => RegisteredNode | undefined;
  readonly findByTool: (toolName: string) => readonly RegisteredNode[];
  readonly nodes: () => ReadonlyMap<string, RegisteredNode>;
  readonly size: () => number;
  readonly updateHeartbeat: (nodeId: string) => Result<void, KoiError>;
  readonly updateCapacity: (nodeId: string, capacity: CapacityReport) => Result<void, KoiError>;
}

// ---------------------------------------------------------------------------
// In-memory implementation
// ---------------------------------------------------------------------------

export function createInMemoryNodeRegistry(): NodeRegistry {
  const nodeMap = new Map<string, RegisteredNode>();
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
    register(node: RegisteredNode): Result<void, KoiError> {
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

    lookup(nodeId: string): RegisteredNode | undefined {
      return nodeMap.get(nodeId);
    },

    findByTool(toolName: string): readonly RegisteredNode[] {
      const ids = toolIndex.get(toolName);
      if (ids === undefined) return [];
      const result: RegisteredNode[] = [];
      for (const id of ids) {
        const node = nodeMap.get(id);
        if (node !== undefined) {
          result.push(node);
        }
      }
      return result;
    },

    nodes(): ReadonlyMap<string, RegisteredNode> {
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
  };
}
