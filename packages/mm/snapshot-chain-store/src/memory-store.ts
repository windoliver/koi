/**
 * InMemorySnapshotChainStore — Map-based store for tests and development.
 *
 * No persistence across restarts. Supports full DAG topology,
 * content-hash deduplication, ancestor walking, forking, and pruning.
 */

import type {
  AncestorQuery,
  ChainId,
  ForkRef,
  KoiError,
  NodeId,
  PruningPolicy,
  PutOptions,
  Result,
  SnapshotChainStore,
  SnapshotNode,
} from "@koi/core";
import { notFound, validation } from "@koi/core";
import { computeContentHash } from "@koi/hash";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function createInMemorySnapshotChainStore<T>(): SnapshotChainStore<T> {
  // nodeId → SnapshotNode<T>
  const nodesByNodeId = new Map<NodeId, SnapshotNode<T>>();
  // chainId → NodeId[] (insertion order, newest last)
  const chainNodes = new Map<ChainId, NodeId[]>();
  // chainId → latest NodeId
  const chainHeads = new Map<ChainId, NodeId>();

  function generateNodeId(): NodeId {
    return `node-${crypto.randomUUID()}` as NodeId;
  }

  function getChainNodeIds(cid: ChainId): NodeId[] {
    let list = chainNodes.get(cid);
    if (list === undefined) {
      list = [];
      chainNodes.set(cid, list);
    }
    return list;
  }

  // -----------------------------------------------------------------------
  // put
  // -----------------------------------------------------------------------

  const put = (
    cid: ChainId,
    data: T,
    parentIds: readonly NodeId[],
    metadata?: Readonly<Record<string, unknown>>,
    options?: PutOptions,
  ): Result<SnapshotNode<T> | undefined, KoiError> => {
    // Validate parent IDs exist
    for (const pid of parentIds) {
      if (!nodesByNodeId.has(pid)) {
        return {
          ok: false,
          error: validation(`Parent node not found: ${pid}`),
        };
      }
    }

    const hash = computeContentHash(data);

    // Check skipIfUnchanged
    if (options?.skipIfUnchanged === true) {
      const headId = chainHeads.get(cid);
      if (headId !== undefined) {
        const headNode = nodesByNodeId.get(headId);
        if (headNode !== undefined && headNode.contentHash === hash) {
          return { ok: true, value: undefined };
        }
      }
    }

    const nid = generateNodeId();
    const node: SnapshotNode<T> = {
      nodeId: nid,
      chainId: cid,
      parentIds: [...parentIds],
      contentHash: hash,
      data,
      createdAt: Date.now(),
      metadata: metadata ?? {},
    };

    nodesByNodeId.set(nid, node);
    getChainNodeIds(cid).push(nid);
    chainHeads.set(cid, nid);

    return { ok: true, value: node };
  };

  // -----------------------------------------------------------------------
  // get
  // -----------------------------------------------------------------------

  const get = (nid: NodeId): Result<SnapshotNode<T>, KoiError> => {
    const node = nodesByNodeId.get(nid);
    if (node === undefined) {
      return { ok: false, error: notFound(nid, `Snapshot node not found: ${nid}`) };
    }
    return { ok: true, value: node };
  };

  // -----------------------------------------------------------------------
  // head
  // -----------------------------------------------------------------------

  const head = (cid: ChainId): Result<SnapshotNode<T> | undefined, KoiError> => {
    const headId = chainHeads.get(cid);
    if (headId === undefined) {
      return { ok: true, value: undefined };
    }
    const node = nodesByNodeId.get(headId);
    return { ok: true, value: node };
  };

  // -----------------------------------------------------------------------
  // list
  // -----------------------------------------------------------------------

  const list = (cid: ChainId): Result<readonly SnapshotNode<T>[], KoiError> => {
    const ids = chainNodes.get(cid);
    if (ids === undefined || ids.length === 0) {
      return { ok: true, value: [] };
    }
    // Return newest first (reverse of insertion order)
    const nodes: SnapshotNode<T>[] = [];
    for (let i = ids.length - 1; i >= 0; i--) {
      const nid = ids[i];
      if (nid === undefined) continue;
      const node = nodesByNodeId.get(nid);
      if (node !== undefined) {
        nodes.push(node);
      }
    }
    return { ok: true, value: nodes };
  };

  // -----------------------------------------------------------------------
  // ancestors
  // -----------------------------------------------------------------------

  const ancestors = (query: AncestorQuery): Result<readonly SnapshotNode<T>[], KoiError> => {
    const startNode = nodesByNodeId.get(query.startNodeId);
    if (startNode === undefined) {
      return {
        ok: false,
        error: notFound(query.startNodeId, `Start node not found: ${query.startNodeId}`),
      };
    }

    // BFS walk following parentIds, with depth limit and dedup
    const result: SnapshotNode<T>[] = [];
    const visited = new Set<NodeId>();
    // Queue: [node, depth]
    const queue: Array<readonly [SnapshotNode<T>, number]> = [[startNode, 1]];

    while (queue.length > 0) {
      const entry = queue.shift();
      if (entry === undefined) break;
      const [node, depth] = entry;

      if (visited.has(node.nodeId)) continue;
      visited.add(node.nodeId);
      result.push(node);

      // Respect maxDepth
      if (query.maxDepth !== undefined && depth >= query.maxDepth) continue;

      // Enqueue parents
      for (const pid of node.parentIds) {
        if (!visited.has(pid)) {
          const parentNode = nodesByNodeId.get(pid);
          if (parentNode !== undefined) {
            queue.push([parentNode, depth + 1]);
          }
        }
      }
    }

    return { ok: true, value: result };
  };

  // -----------------------------------------------------------------------
  // fork
  // -----------------------------------------------------------------------

  const fork = (
    sourceNodeId: NodeId,
    newChainId: ChainId,
    label: string,
  ): Result<ForkRef, KoiError> => {
    const sourceNode = nodesByNodeId.get(sourceNodeId);
    if (sourceNode === undefined) {
      return {
        ok: false,
        error: notFound(sourceNodeId, `Source node not found: ${sourceNodeId}`),
      };
    }

    // Register the source node as the head of the new chain
    getChainNodeIds(newChainId).push(sourceNodeId);
    chainHeads.set(newChainId, sourceNodeId);

    const ref: ForkRef = {
      parentNodeId: sourceNodeId,
      label,
    };
    return { ok: true, value: ref };
  };

  // -----------------------------------------------------------------------
  // prune
  // -----------------------------------------------------------------------

  const prune = (cid: ChainId, policy: PruningPolicy): Result<number, KoiError> => {
    const ids = chainNodes.get(cid);
    if (ids === undefined || ids.length === 0) {
      return { ok: true, value: 0 };
    }

    const now = Date.now();
    // Determine which nodes to remove
    const toRemove = new Set<number>(); // indices into ids

    // retainCount: keep the newest N, remove the rest from the beginning
    if (policy.retainCount !== undefined && ids.length > policy.retainCount) {
      const removeCount = ids.length - policy.retainCount;
      for (let i = 0; i < removeCount; i++) {
        toRemove.add(i);
      }
    }

    // retainDuration: remove nodes older than the cutoff
    if (policy.retainDuration !== undefined) {
      const cutoff = now - policy.retainDuration;
      for (let i = 0; i < ids.length; i++) {
        const nid = ids[i];
        if (nid === undefined) continue;
        const node = nodesByNodeId.get(nid);
        if (node !== undefined && node.createdAt < cutoff) {
          toRemove.add(i);
        }
      }
    }

    // Protect branch heads if retainBranches !== false (default true)
    if (policy.retainBranches !== false) {
      // The last node (chain head) should never be pruned
      toRemove.delete(ids.length - 1);
    }

    // Remove nodes
    const indicesToRemove = [...toRemove].sort((a, b) => b - a); // descending for safe splicing
    let removedCount = 0;
    for (const idx of indicesToRemove) {
      const nid = ids[idx];
      if (nid !== undefined) {
        // Only delete from global map if no other chain references this node
        const referencedElsewhere = [...chainNodes.entries()].some(
          ([otherId, nodeIds]) => otherId !== cid && nodeIds.includes(nid),
        );
        if (!referencedElsewhere) {
          nodesByNodeId.delete(nid);
        }
        removedCount += 1;
      }
      ids.splice(idx, 1);
    }

    // Update head if chain is now empty
    if (ids.length === 0) {
      chainHeads.delete(cid);
    }

    return { ok: true, value: removedCount };
  };

  // -----------------------------------------------------------------------
  // close
  // -----------------------------------------------------------------------

  const close = (): void => {
    nodesByNodeId.clear();
    chainNodes.clear();
    chainHeads.clear();
  };

  return {
    put,
    get,
    head,
    list,
    ancestors,
    fork,
    prune,
    close,
  };
}
