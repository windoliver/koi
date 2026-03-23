/**
 * Nexus-backed SnapshotChainStore implementation.
 *
 * Stores snapshot nodes as JSON files on a Nexus server. Each chain is
 * a directory containing node files. Supports DAG topology, content-hash
 * deduplication, ancestor walking, forking, and pruning.
 *
 * Path convention:
 *   /snapshots/{chainId}/{nodeId}.json   — node payload
 *   /snapshots/{chainId}/meta.json       — chain metadata (head, count)
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
import { nodeId as createNodeId, notFound, validation } from "@koi/core";
import { computeContentHash } from "@koi/hash";
import type { NexusClient } from "@koi/nexus-client";
import { createNexusClient } from "@koi/nexus-client";
import { validatePathSegment, wrapNexusError } from "./shared/nexus-helpers.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const DEFAULT_BASE_PATH = "snapshots";

export interface NexusSnapshotStoreConfig {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly basePath?: string;
  readonly fetch?: typeof globalThis.fetch;
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface ChainMeta {
  readonly headNodeId: NodeId | null;
  readonly nodeIds: readonly NodeId[];
}

const EMPTY_META: ChainMeta = { headNodeId: null, nodeIds: [] };

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/** Create a Nexus-backed SnapshotChainStore for multi-node deployments. */
export function createNexusSnapshotStore<T>(
  config: NexusSnapshotStoreConfig,
): SnapshotChainStore<T> {
  const basePath = config.basePath ?? DEFAULT_BASE_PATH;
  const client: NexusClient = createNexusClient({
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    fetch: config.fetch,
  });

  // --- path helpers -------------------------------------------------------

  function nodePath(cid: ChainId, nid: NodeId): string {
    return `${basePath}/${cid}/${nid}.json`;
  }

  function metaPath(cid: ChainId): string {
    return `${basePath}/${cid}/meta.json`;
  }

  // --- meta helpers -------------------------------------------------------

  async function readMeta(cid: ChainId): Promise<Result<ChainMeta, KoiError>> {
    const r = await client.rpc<string>("read", { path: metaPath(cid) });
    if (!r.ok) {
      if (r.error.code === "EXTERNAL" || r.error.code === "NOT_FOUND") {
        return { ok: true, value: EMPTY_META };
      }
      return r;
    }
    try {
      const parsed: unknown = typeof r.value === "string" ? JSON.parse(r.value) : r.value;
      if (
        parsed !== null &&
        typeof parsed === "object" &&
        "nodeIds" in parsed &&
        Array.isArray((parsed as ChainMeta).nodeIds)
      ) {
        return { ok: true, value: parsed as ChainMeta };
      }
      // Data doesn't match ChainMeta shape — treat as empty
      return { ok: true, value: EMPTY_META };
    } catch {
      // Corrupted or incompatible meta — treat as empty to avoid blocking persistence
      return { ok: true, value: EMPTY_META };
    }
  }

  async function writeMeta(cid: ChainId, meta: ChainMeta): Promise<Result<void, KoiError>> {
    const r = await client.rpc<null>("write", {
      path: metaPath(cid),
      content: JSON.stringify(meta),
    });
    if (!r.ok) return r;
    return { ok: true, value: undefined };
  }

  // --- node helpers -------------------------------------------------------

  async function readNode(cid: ChainId, nid: NodeId): Promise<Result<SnapshotNode<T>, KoiError>> {
    const r = await client.rpc<string>("read", { path: nodePath(cid, nid) });
    if (!r.ok) {
      if (r.error.code === "EXTERNAL" || r.error.code === "NOT_FOUND") {
        return { ok: false, error: notFound(nid, `Snapshot node not found: ${nid}`) };
      }
      return r;
    }
    try {
      return { ok: true, value: JSON.parse(r.value) as SnapshotNode<T> };
    } catch (e: unknown) {
      return {
        ok: false,
        error: wrapNexusError("INTERNAL", `Failed to parse snapshot node ${nid}`, e),
      };
    }
  }

  async function writeNode(node: SnapshotNode<T>): Promise<Result<void, KoiError>> {
    const r = await client.rpc<null>("write", {
      path: nodePath(node.chainId, node.nodeId),
      content: JSON.stringify(node),
    });
    if (!r.ok) return r;
    return { ok: true, value: undefined };
  }

  // --- Per-chain mutex to serialize meta read-modify-write -----------------

  // Map — mutable lock queue per chain for serializing concurrent put/prune
  const chainLocks = new Map<ChainId, Promise<void>>();

  async function withChainLock<R>(cid: ChainId, fn: () => Promise<R>): Promise<R> {
    const prev = chainLocks.get(cid) ?? Promise.resolve();
    const deferred = createDeferred();
    chainLocks.set(cid, deferred.promise);

    await prev;
    try {
      return await fn();
    } finally {
      deferred.resolve();
    }
  }

  function createDeferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
    // let justified: resolve is assigned synchronously in the Promise constructor
    let resolveFn: () => void = () => {};
    const promise = new Promise<void>((resolve) => {
      resolveFn = resolve;
    });
    return { promise, resolve: resolveFn };
  }

  // --- SnapshotChainStore methods -----------------------------------------

  const put = async (
    cid: ChainId,
    data: T,
    parentIds: readonly NodeId[],
    metadata?: Readonly<Record<string, unknown>>,
    options?: PutOptions,
  ): Promise<Result<SnapshotNode<T> | undefined, KoiError>> => {
    const chainSegCheck = validatePathSegment(cid, "Chain ID");
    if (!chainSegCheck.ok) return chainSegCheck;
    for (const pid of parentIds) {
      const pidSegCheck = validatePathSegment(pid, "Parent Node ID");
      if (!pidSegCheck.ok) return pidSegCheck;
    }
    // Validate parents exist (outside lock — read-only)
    for (const pid of parentIds) {
      const parentMeta = await client.rpc<boolean>("exists", { path: nodePath(cid, pid) });
      if (!parentMeta.ok) return parentMeta;
      if (!parentMeta.value) {
        return { ok: false, error: validation(`Parent node not found: ${pid}`) };
      }
    }

    return withChainLock(cid, async () => {
      const hash = computeContentHash(data);
      const metaResult = await readMeta(cid);
      if (!metaResult.ok) return metaResult;
      const meta = metaResult.value;

      // skipIfUnchanged
      if (options?.skipIfUnchanged === true && meta.headNodeId !== null) {
        const headResult = await readNode(cid, meta.headNodeId);
        if (headResult.ok && headResult.value.contentHash === hash) {
          return { ok: true, value: undefined };
        }
      }

      const nid = createNodeId(`node-${crypto.randomUUID()}`);
      const node: SnapshotNode<T> = {
        nodeId: nid,
        chainId: cid,
        parentIds: [...parentIds],
        contentHash: hash,
        data,
        createdAt: Date.now(),
        metadata: metadata ?? {},
      };

      const writeResult = await writeNode(node);
      if (!writeResult.ok) return writeResult;

      const newMeta: ChainMeta = {
        headNodeId: nid,
        nodeIds: [...meta.nodeIds, nid],
      };
      const metaWriteResult = await writeMeta(cid, newMeta);
      if (!metaWriteResult.ok) return metaWriteResult;

      return { ok: true, value: node };
    });
  };

  const get = async (nid: NodeId): Promise<Result<SnapshotNode<T>, KoiError>> => {
    const nodeSegCheck = validatePathSegment(nid, "Node ID");
    if (!nodeSegCheck.ok) return nodeSegCheck;
    // We need to find which chain this node belongs to — scan all chains
    const globResult = await client.rpc<readonly string[]>("glob", {
      pattern: `${basePath}/*/${nid}.json`,
    });
    if (!globResult.ok) return globResult;
    if (globResult.value.length === 0) {
      return { ok: false, error: notFound(nid, `Snapshot node not found: ${nid}`) };
    }
    const path = globResult.value[0];
    if (path === undefined) {
      return { ok: false, error: notFound(nid, `Snapshot node not found: ${nid}`) };
    }

    const r = await client.rpc<string>("read", { path });
    if (!r.ok) {
      if (r.error.code === "EXTERNAL" || r.error.code === "NOT_FOUND") {
        return { ok: false, error: notFound(nid, `Snapshot node not found: ${nid}`) };
      }
      return r;
    }
    try {
      return { ok: true, value: JSON.parse(r.value) as SnapshotNode<T> };
    } catch (e: unknown) {
      return {
        ok: false,
        error: wrapNexusError("INTERNAL", `Failed to parse snapshot node ${nid}`, e),
      };
    }
  };

  const head = async (cid: ChainId): Promise<Result<SnapshotNode<T> | undefined, KoiError>> => {
    const chainSegCheck = validatePathSegment(cid, "Chain ID");
    if (!chainSegCheck.ok) return chainSegCheck;
    const metaResult = await readMeta(cid);
    if (!metaResult.ok) return metaResult;
    if (metaResult.value.headNodeId === null) {
      return { ok: true, value: undefined };
    }
    return readNode(cid, metaResult.value.headNodeId);
  };

  const list = async (cid: ChainId): Promise<Result<readonly SnapshotNode<T>[], KoiError>> => {
    const chainSegCheck = validatePathSegment(cid, "Chain ID");
    if (!chainSegCheck.ok) return chainSegCheck;
    const metaResult = await readMeta(cid);
    if (!metaResult.ok) return metaResult;
    const ids = metaResult.value.nodeIds;
    if (ids.length === 0) return { ok: true, value: [] };

    // Read all nodes, newest first
    const nodes: SnapshotNode<T>[] = [];
    for (let i = ids.length - 1; i >= 0; i--) {
      const nid = ids[i];
      if (nid === undefined) continue;
      const r = await readNode(cid, nid);
      if (r.ok) nodes.push(r.value);
    }
    return { ok: true, value: nodes };
  };

  const ancestors = async (
    query: AncestorQuery,
  ): Promise<Result<readonly SnapshotNode<T>[], KoiError>> => {
    const startResult = await get(query.startNodeId);
    if (!startResult.ok) return startResult;

    const result: SnapshotNode<T>[] = [];
    const visited = new Set<NodeId>();
    const queue: Array<readonly [SnapshotNode<T>, number]> = [[startResult.value, 1]];

    while (queue.length > 0) {
      const entry = queue.shift();
      if (entry === undefined) break;
      const [node, depth] = entry;

      if (visited.has(node.nodeId)) continue;
      visited.add(node.nodeId);
      result.push(node);

      if (query.maxDepth !== undefined && depth >= query.maxDepth) continue;

      for (const pid of node.parentIds) {
        if (!visited.has(pid)) {
          const parentResult = await get(pid);
          if (parentResult.ok) {
            queue.push([parentResult.value, depth + 1]);
          }
        }
      }
    }

    return { ok: true, value: result };
  };

  const fork = async (
    sourceNodeId: NodeId,
    newChainId: ChainId,
    label: string,
  ): Promise<Result<ForkRef, KoiError>> => {
    const nodeSegCheck = validatePathSegment(sourceNodeId, "Source Node ID");
    if (!nodeSegCheck.ok) return nodeSegCheck;
    const chainSegCheck = validatePathSegment(newChainId, "New Chain ID");
    if (!chainSegCheck.ok) return chainSegCheck;
    const sourceResult = await get(sourceNodeId);
    if (!sourceResult.ok) return sourceResult;

    // Copy the source node file into the new chain directory so readNode can find it
    const copyResult = await writeNode({
      ...sourceResult.value,
      chainId: newChainId,
    });
    if (!copyResult.ok) return copyResult;

    const newMeta: ChainMeta = { headNodeId: sourceNodeId, nodeIds: [sourceNodeId] };
    const metaWriteResult = await writeMeta(newChainId, newMeta);
    if (!metaWriteResult.ok) return metaWriteResult;

    return { ok: true, value: { parentNodeId: sourceNodeId, label } };
  };

  const prune = async (cid: ChainId, policy: PruningPolicy): Promise<Result<number, KoiError>> => {
    const chainSegCheck = validatePathSegment(cid, "Chain ID");
    if (!chainSegCheck.ok) return chainSegCheck;
    return withChainLock(cid, async () => {
      const metaResult = await readMeta(cid);
      if (!metaResult.ok) return metaResult;
      const ids = [...metaResult.value.nodeIds];
      if (ids.length === 0) return { ok: true, value: 0 };

      const now = Date.now();
      const toRemove = new Set<number>();

      // retainCount
      if (policy.retainCount !== undefined && ids.length > policy.retainCount) {
        const removeCount = ids.length - policy.retainCount;
        for (let i = 0; i < removeCount; i++) {
          toRemove.add(i);
        }
      }

      // retainDuration
      if (policy.retainDuration !== undefined) {
        const cutoff = now - policy.retainDuration;
        for (let i = 0; i < ids.length; i++) {
          const nid = ids[i];
          if (nid === undefined) continue;
          const nodeResult = await readNode(cid, nid);
          if (nodeResult.ok && nodeResult.value.createdAt < cutoff) {
            toRemove.add(i);
          }
        }
      }

      // Protect head
      if (policy.retainBranches !== false) {
        toRemove.delete(ids.length - 1);
      }

      // Remove nodes
      const indicesToRemove = [...toRemove].sort((a, b) => b - a);
      // let justified: count of removed nodes for return value
      let removedCount = 0;
      for (const idx of indicesToRemove) {
        const nid = ids[idx];
        if (nid !== undefined) {
          await client.rpc<null>("delete", { path: nodePath(cid, nid) });
          removedCount += 1;
        }
        ids.splice(idx, 1);
      }

      // Update meta
      const newHead = ids.length > 0 ? (ids[ids.length - 1] ?? null) : null;
      const updateResult = await writeMeta(cid, { headNodeId: newHead, nodeIds: ids });
      if (!updateResult.ok) return updateResult;

      return { ok: true, value: removedCount };
    });
  };

  const close = (): void => {
    // No persistent resources to release for Nexus RPC
  };

  return { put, get, head, list, ancestors, fork, prune, close };
}
