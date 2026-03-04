/**
 * Nexus-backed NodeRegistry with local projection.
 *
 * All reads are local (sync). Writes update local state and enqueue
 * Nexus persistence. Polling syncs state from other gateway instances.
 */

import type { AdvertisedTool, CapacityReport, KoiError, Result } from "@koi/core";
import { conflict, notFound, validation } from "@koi/core";
import type { NodeRegistry, RegisteredNode } from "@koi/gateway-types";
import type { NexusClient } from "@koi/nexus-client";
import { gatewayNodePath } from "@koi/nexus-client";
import type { DegradationConfig, GatewayNexusConfig } from "./config.js";
import { DEFAULT_DEGRADATION_CONFIG } from "./config.js";
import type { DegradationState } from "./degradation.js";
import { createDegradationState, recordFailure, recordSuccess } from "./degradation.js";
import type { WriteQueue } from "./write-queue.js";
import { createWriteQueue } from "./write-queue.js";

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export interface NexusNodeRegistryOptions {
  readonly client: NexusClient;
  readonly config: GatewayNexusConfig;
}

export interface NexusNodeRegistryHandle {
  readonly registry: NodeRegistry;
  readonly degradation: () => DegradationState;
  readonly dispose: () => Promise<void>;
}

export function createNexusNodeRegistry(
  options: NexusNodeRegistryOptions,
): NexusNodeRegistryHandle {
  const { client, config } = options;
  const degradationConfig: DegradationConfig = {
    ...DEFAULT_DEGRADATION_CONFIG,
    ...config.degradation,
  };
  const nodeMap = new Map<string, RegisteredNode>();
  const toolIndex = new Map<string, Set<string>>();
  let degradation = createDegradationState();

  const writeFn = async (path: string, data: string): Promise<void> => {
    const r = await client.rpc<null>("write", { path, content: data });
    if (r.ok) {
      degradation = recordSuccess(degradation);
    } else {
      degradation = recordFailure(degradation, degradationConfig);
    }
  };

  const queue: WriteQueue = createWriteQueue(writeFn, config.writeQueue);

  // Tool index helpers
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

  function enqueueNode(node: RegisteredNode, immediate: boolean): void {
    queue.enqueue(gatewayNodePath(node.nodeId), JSON.stringify(node), immediate);
  }

  const registry: NodeRegistry = {
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
      enqueueNode(node, true);
      return { ok: true, value: undefined };
    },

    deregister(nodeId: string): Result<boolean, KoiError> {
      const existing = nodeMap.get(nodeId);
      if (existing === undefined) {
        return { ok: true, value: false };
      }
      removeFromToolIndex(nodeId, existing.tools);
      nodeMap.delete(nodeId);
      // Immediate Nexus delete
      void client
        .rpc<null>("delete", { path: gatewayNodePath(nodeId) })
        .then((r) => {
          if (r.ok) {
            degradation = recordSuccess(degradation);
          } else {
            degradation = recordFailure(degradation, degradationConfig);
          }
        })
        .catch((_e: unknown) => {
          degradation = recordFailure(degradation, degradationConfig);
        });
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
        return { ok: false, error: notFound(nodeId, `Node not found: ${nodeId}`) };
      }
      const updated: RegisteredNode = { ...existing, lastHeartbeat: Date.now() };
      nodeMap.set(nodeId, updated);
      enqueueNode(updated, false);
      return { ok: true, value: undefined };
    },

    updateCapacity(nodeId: string, capacity: CapacityReport): Result<void, KoiError> {
      const existing = nodeMap.get(nodeId);
      if (existing === undefined) {
        return { ok: false, error: notFound(nodeId, `Node not found: ${nodeId}`) };
      }
      const updated: RegisteredNode = { ...existing, capacity };
      nodeMap.set(nodeId, updated);
      enqueueNode(updated, false);
      return { ok: true, value: undefined };
    },

    updateTools(
      nodeId: string,
      added: readonly AdvertisedTool[],
      removed: readonly string[],
    ): Result<void, KoiError> {
      const existing = nodeMap.get(nodeId);
      if (existing === undefined) {
        return { ok: false, error: notFound(nodeId, `Node not found: ${nodeId}`) };
      }

      const removedSet = new Set(removed);
      const removedTools = existing.tools.filter((t) => removedSet.has(t.name));
      removeFromToolIndex(nodeId, removedTools);
      addToToolIndex(nodeId, added);

      const keptTools = existing.tools.filter((t) => !removedSet.has(t.name));
      const newTools = [...keptTools, ...added];
      const updated: RegisteredNode = { ...existing, tools: newTools };
      nodeMap.set(nodeId, updated);
      enqueueNode(updated, false);
      return { ok: true, value: undefined };
    },
  };

  return {
    registry,
    degradation: () => degradation,
    dispose: () => queue.dispose(),
  };
}
