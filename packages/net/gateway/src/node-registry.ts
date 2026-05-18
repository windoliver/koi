import type { AdvertisedTool, CapacityReport, KoiError, NodeCapability, Result } from "@koi/core";
import { notFound, validation } from "@koi/core";

export interface RegisteredNode {
  readonly nodeId: string;
  readonly nodeType: "full" | "thin";
  readonly tools: readonly AdvertisedTool[];
  readonly capacity: CapacityReport;
  readonly connectedAt: number;
  readonly lastHeartbeat: number;
  readonly connId: string;
}

export type NodeRegistryEvent =
  | { readonly kind: "registered"; readonly node: RegisteredNode }
  | { readonly kind: "deregistered"; readonly nodeId: string; readonly reason: string }
  | { readonly kind: "offline"; readonly nodeId: string; readonly reason: string }
  | { readonly kind: "heartbeat"; readonly nodeId: string }
  | { readonly kind: "capabilities_updated"; readonly nodeId: string };

export interface NodeRegistry {
  readonly register: (node: RegisteredNode) => Result<void, KoiError>;
  readonly deregister: (nodeId: string) => Result<boolean, KoiError>;
  readonly lookup: (nodeId: string) => RegisteredNode | undefined;
  readonly resolve: (toolName: string) => readonly NodeCapability[];
  readonly nodes: () => ReadonlyMap<string, RegisteredNode>;
  readonly size: () => number;
  readonly updateHeartbeat: (nodeId: string, now?: number) => Result<void, KoiError>;
  readonly updateCapabilities: (
    nodeId: string,
    nodeType: RegisteredNode["nodeType"],
    tools: readonly AdvertisedTool[],
  ) => Result<void, KoiError>;
  readonly updateTools: (
    nodeId: string,
    added: readonly AdvertisedTool[],
    removed: readonly string[],
  ) => Result<void, KoiError>;
}

function addIndexed(
  index: ReadonlyMap<string, ReadonlySet<string>>,
  nodeId: string,
  tools: readonly AdvertisedTool[],
): Map<string, ReadonlySet<string>> {
  let next = new Map(index);
  for (const tool of tools) {
    const existing = next.get(tool.name) ?? new Set<string>();
    next = new Map(next).set(tool.name, new Set([...existing, nodeId]));
  }
  return next;
}

function removeIndexed(
  index: ReadonlyMap<string, ReadonlySet<string>>,
  nodeId: string,
  tools: readonly AdvertisedTool[],
): Map<string, ReadonlySet<string>> {
  let next = new Map(index);
  for (const tool of tools) {
    const existing = next.get(tool.name);
    if (existing === undefined) continue;
    const remaining = new Set([...existing].filter((id) => id !== nodeId));
    next =
      remaining.size === 0
        ? new Map([...next].filter(([name]) => name !== tool.name))
        : new Map(next).set(tool.name, remaining);
  }
  return next;
}

class InMemoryNodeRegistry implements NodeRegistry {
  private nodeMap = new Map<string, RegisteredNode>();
  private toolIndex = new Map<string, ReadonlySet<string>>();

  register(node: RegisteredNode): Result<void, KoiError> {
    if (node.nodeId.length === 0) {
      return { ok: false, error: validation("nodeId must not be empty") };
    }
    const previous = this.nodeMap.get(node.nodeId);
    if (previous !== undefined) {
      this.toolIndex = removeIndexed(this.toolIndex, node.nodeId, previous.tools);
    }
    this.nodeMap = new Map(this.nodeMap).set(node.nodeId, node);
    this.toolIndex = addIndexed(this.toolIndex, node.nodeId, node.tools);
    return { ok: true, value: undefined };
  }

  deregister(nodeId: string): Result<boolean, KoiError> {
    const existing = this.nodeMap.get(nodeId);
    if (existing === undefined) return { ok: true, value: false };
    this.nodeMap = new Map([...this.nodeMap].filter(([id]) => id !== nodeId));
    this.toolIndex = removeIndexed(this.toolIndex, nodeId, existing.tools);
    return { ok: true, value: true };
  }

  lookup(nodeId: string): RegisteredNode | undefined {
    return this.nodeMap.get(nodeId);
  }

  resolve(toolName: string): readonly NodeCapability[] {
    const ids = this.toolIndex.get(toolName) ?? new Set<string>();
    return [...ids].flatMap((nodeId): readonly NodeCapability[] => {
      const node = this.nodeMap.get(nodeId);
      if (node === undefined) return [];
      return [
        { nodeId, nodeType: node.nodeType, tools: node.tools.filter((t) => t.name === toolName) },
      ];
    });
  }

  nodes(): ReadonlyMap<string, RegisteredNode> {
    return this.nodeMap;
  }

  size(): number {
    return this.nodeMap.size;
  }

  updateHeartbeat(nodeId: string, now = Date.now()): Result<void, KoiError> {
    const existing = this.find(nodeId);
    if (!existing.ok) return { ok: false, error: existing.error };
    this.nodeMap = new Map(this.nodeMap).set(nodeId, { ...existing.value, lastHeartbeat: now });
    return { ok: true, value: undefined };
  }

  updateCapabilities(
    nodeId: string,
    nodeType: RegisteredNode["nodeType"],
    tools: readonly AdvertisedTool[],
  ): Result<void, KoiError> {
    const existing = this.find(nodeId);
    if (!existing.ok) return { ok: false, error: existing.error };
    this.toolIndex = removeIndexed(this.toolIndex, nodeId, existing.value.tools);
    this.toolIndex = addIndexed(this.toolIndex, nodeId, tools);
    this.nodeMap = new Map(this.nodeMap).set(nodeId, { ...existing.value, nodeType, tools });
    return { ok: true, value: undefined };
  }

  updateTools(
    nodeId: string,
    added: readonly AdvertisedTool[],
    removed: readonly string[],
  ): Result<void, KoiError> {
    const existing = this.find(nodeId);
    if (!existing.ok) return { ok: false, error: existing.error };
    const next = mergeTools(existing.value.tools, added, removed);
    this.toolIndex = removeIndexed(this.toolIndex, nodeId, next.removed);
    this.toolIndex = removeIndexed(this.toolIndex, nodeId, next.replaced);
    this.toolIndex = addIndexed(this.toolIndex, nodeId, added);
    this.nodeMap = new Map(this.nodeMap).set(nodeId, { ...existing.value, tools: next.tools });
    return { ok: true, value: undefined };
  }

  private find(nodeId: string): Result<RegisteredNode, KoiError> {
    const existing = this.nodeMap.get(nodeId);
    if (existing === undefined) {
      return { ok: false, error: notFound(nodeId, `Node not found: ${nodeId}`) };
    }
    return { ok: true, value: existing };
  }
}

function mergeTools(
  existing: readonly AdvertisedTool[],
  added: readonly AdvertisedTool[],
  removed: readonly string[],
): {
  readonly tools: readonly AdvertisedTool[];
  readonly removed: readonly AdvertisedTool[];
  readonly replaced: readonly AdvertisedTool[];
} {
  const removedSet = new Set(removed);
  const addedNames = new Set(added.map((tool) => tool.name));
  const kept = existing.filter((tool) => !removedSet.has(tool.name));
  return {
    tools: [...kept.filter((tool) => !addedNames.has(tool.name)), ...added],
    removed: existing.filter((tool) => removedSet.has(tool.name)),
    replaced: kept.filter((tool) => addedNames.has(tool.name)),
  };
}

export function createInMemoryNodeRegistry(): NodeRegistry {
  return new InMemoryNodeRegistry();
}
