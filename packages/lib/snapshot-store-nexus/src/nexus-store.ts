/**
 * Nexus-backed `SnapshotChainStore<T>`.
 *
 * Each chain lives at <basePath>/<chainId>/, with one JSON file per node and
 * a meta.json holding the head pointer + node order. Per-chain mutex
 * serializes meta read-modify-write within a single process.
 */

import type {
  AncestorQuery,
  ChainId,
  ForkRef,
  KoiError,
  NodeId,
  PruningPolicy,
  Result,
  SnapshotChainStore,
  SnapshotNode,
} from "@koi/core";
import { nodeId as makeNodeId, notFound, validation } from "@koi/core";
import { computeContentHash } from "@koi/hash";
import { deleteJson, exists, listChildren, readJson, writeJson } from "./json-io.js";
import { metaPath, nodePath, validateSegment } from "./paths.js";
import type { NexusSnapshotStoreConfig } from "./types.js";

interface ChainMeta {
  readonly headNodeId: NodeId | null;
  readonly nodeIds: readonly NodeId[];
}

const EMPTY_META: ChainMeta = { headNodeId: null, nodeIds: [] };

const DEFAULT_BASE_PATH = "snapshots";

export function createSnapshotStoreNexus<T>(
  config: NexusSnapshotStoreConfig,
): SnapshotChainStore<T> {
  const basePath = config.basePath ?? DEFAULT_BASE_PATH;
  const transport = config.transport;
  const chainLocks = new Map<ChainId, Promise<void>>();

  async function readMeta(cid: ChainId): Promise<Result<ChainMeta, KoiError>> {
    const r = await readJson<ChainMeta>(transport, metaPath(basePath, cid));
    if (!r.ok) return r;
    if (r.value === undefined) return { ok: true, value: EMPTY_META };
    return { ok: true, value: r.value };
  }

  async function writeMeta(cid: ChainId, meta: ChainMeta): Promise<Result<void, KoiError>> {
    return writeJson(transport, metaPath(basePath, cid), meta);
  }

  async function readNode(cid: ChainId, nid: NodeId): Promise<Result<SnapshotNode<T>, KoiError>> {
    const r = await readJson<SnapshotNode<T>>(transport, nodePath(basePath, cid, nid));
    if (!r.ok) return r;
    if (r.value === undefined) {
      return { ok: false, error: notFound(nid, `Snapshot node not found: ${nid}`) };
    }
    return { ok: true, value: r.value };
  }

  async function writeNode(node: SnapshotNode<T>): Promise<Result<void, KoiError>> {
    return writeJson(transport, nodePath(basePath, node.chainId, node.nodeId), node);
  }

  async function withChainLock<R>(cid: ChainId, fn: () => Promise<R>): Promise<R> {
    const prev = chainLocks.get(cid) ?? Promise.resolve();
    // let is justified: release must be assigned inside the Promise constructor callback
    let release = (): void => {};
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    chainLocks.set(cid, next);
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  const put: SnapshotChainStore<T>["put"] = async (
    cid,
    data,
    parentIds,
    metadata,
    options,
  ): Promise<Result<SnapshotNode<T> | undefined, KoiError>> => {
    const seg = validateSegment(cid, "Chain ID");
    if (!seg.ok) return { ok: false, error: seg.error };
    for (const pid of parentIds) {
      const psg = validateSegment(pid, "Parent Node ID");
      if (!psg.ok) return { ok: false, error: psg.error };
    }
    for (const pid of parentIds) {
      const ex = await exists(transport, nodePath(basePath, cid, pid));
      if (!ex.ok) return ex;
      if (!ex.value) return { ok: false, error: validation(`Parent node not found: ${pid}`) };
    }
    return withChainLock(cid, async () => {
      const hash = computeContentHash(data);
      const metaRes = await readMeta(cid);
      if (!metaRes.ok) return metaRes;
      const meta = metaRes.value;

      if (options?.skipIfUnchanged === true && meta.headNodeId !== null) {
        const head = await readNode(cid, meta.headNodeId);
        if (head.ok && head.value.contentHash === hash) {
          return { ok: true, value: undefined };
        }
      }

      const nid = makeNodeId(`node-${crypto.randomUUID()}`);
      const node: SnapshotNode<T> = {
        nodeId: nid,
        chainId: cid,
        parentIds: [...parentIds],
        contentHash: hash,
        data,
        createdAt: Date.now(),
        metadata: metadata ?? {},
      };
      const wn = await writeNode(node);
      if (!wn.ok) return wn;
      const wm = await writeMeta(cid, {
        headNodeId: nid,
        nodeIds: [...meta.nodeIds, nid],
      });
      if (!wm.ok) return wm;
      return { ok: true, value: node };
    });
  };

  const get: SnapshotChainStore<T>["get"] = async (
    nid,
  ): Promise<Result<SnapshotNode<T>, KoiError>> => {
    const seg = validateSegment(nid, "Node ID");
    if (!seg.ok) return { ok: false, error: seg.error };
    const matches = await listChildren(transport, `${basePath}/*/${nid}.json`);
    if (!matches.ok) return matches;
    const path = matches.value[0];
    if (path === undefined) {
      return { ok: false, error: notFound(nid, `Snapshot node not found: ${nid}`) };
    }
    const r = await readJson<SnapshotNode<T>>(transport, path);
    if (!r.ok) return r;
    if (r.value === undefined) {
      return { ok: false, error: notFound(nid, `Snapshot node not found: ${nid}`) };
    }
    return { ok: true, value: r.value };
  };

  const head: SnapshotChainStore<T>["head"] = async (
    cid,
  ): Promise<Result<SnapshotNode<T> | undefined, KoiError>> => {
    const seg = validateSegment(cid, "Chain ID");
    if (!seg.ok) return { ok: false, error: seg.error };
    const m = await readMeta(cid);
    if (!m.ok) return m;
    if (m.value.headNodeId === null) return { ok: true, value: undefined };
    return readNode(cid, m.value.headNodeId);
  };

  const list: SnapshotChainStore<T>["list"] = async (
    cid,
  ): Promise<Result<readonly SnapshotNode<T>[], KoiError>> => {
    const seg = validateSegment(cid, "Chain ID");
    if (!seg.ok) return { ok: false, error: seg.error };
    const m = await readMeta(cid);
    if (!m.ok) return m;
    const ids = m.value.nodeIds;
    const out: SnapshotNode<T>[] = [];
    for (let i = ids.length - 1; i >= 0; i--) {
      const id = ids[i];
      if (id === undefined) continue;
      const r = await readNode(cid, id);
      if (r.ok) out.push(r.value);
    }
    return { ok: true, value: out };
  };

  const ancestors: SnapshotChainStore<T>["ancestors"] = async (
    query: AncestorQuery,
  ): Promise<Result<readonly SnapshotNode<T>[], KoiError>> => {
    const start = await get(query.startNodeId);
    if (!start.ok) return start;
    const out: SnapshotNode<T>[] = [];
    const visited = new Set<NodeId>();
    // depth 0 = start node; maxDepth is the maximum number of hops from start.
    const queue: Array<readonly [SnapshotNode<T>, number]> = [[start.value, 0]];
    while (queue.length > 0) {
      const entry = queue.shift();
      if (entry === undefined) break;
      const [node, depth] = entry;
      if (visited.has(node.nodeId)) continue;
      visited.add(node.nodeId);
      out.push(node);
      if (query.maxDepth !== undefined && depth >= query.maxDepth) continue;
      for (const pid of node.parentIds) {
        if (visited.has(pid)) continue;
        const pr = await get(pid);
        if (pr.ok) queue.push([pr.value, depth + 1]);
      }
    }
    return { ok: true, value: out };
  };

  const fork: SnapshotChainStore<T>["fork"] = async (
    sourceNodeId,
    newChainId,
    label,
  ): Promise<Result<ForkRef, KoiError>> => {
    const sseg = validateSegment(sourceNodeId, "Source Node ID");
    if (!sseg.ok) return { ok: false, error: sseg.error };
    const cseg = validateSegment(newChainId, "New Chain ID");
    if (!cseg.ok) return { ok: false, error: cseg.error };
    const src = await get(sourceNodeId);
    if (!src.ok) return src;
    const copy: SnapshotNode<T> = { ...src.value, chainId: newChainId };
    const wn = await writeNode(copy);
    if (!wn.ok) return wn;
    const wm = await writeMeta(newChainId, {
      headNodeId: sourceNodeId,
      nodeIds: [sourceNodeId],
    });
    if (!wm.ok) return wm;
    const ref: ForkRef = { parentNodeId: sourceNodeId, label };
    return { ok: true, value: ref };
  };

  const prune: SnapshotChainStore<T>["prune"] = async (
    cid,
    policy: PruningPolicy,
  ): Promise<Result<number, KoiError>> => {
    const seg = validateSegment(cid, "Chain ID");
    if (!seg.ok) return { ok: false, error: seg.error };
    return withChainLock(cid, async () => {
      const m = await readMeta(cid);
      if (!m.ok) return m;
      const ids = [...m.value.nodeIds];
      if (ids.length === 0) return { ok: true, value: 0 };

      const remove = new Set<number>();
      if (policy.retainCount !== undefined && ids.length > policy.retainCount) {
        for (let i = 0; i < ids.length - policy.retainCount; i++) remove.add(i);
      }
      if (policy.retainDuration !== undefined) {
        const cutoff = Date.now() - policy.retainDuration;
        for (let i = 0; i < ids.length; i++) {
          const id = ids[i];
          if (id === undefined) continue;
          const node = await readNode(cid, id);
          if (node.ok && node.value.createdAt < cutoff) remove.add(i);
        }
      }
      if (policy.retainBranches !== false) remove.delete(ids.length - 1);

      const sorted = [...remove].sort((a, b) => b - a);
      let removed = 0;
      for (const idx of sorted) {
        const id = ids[idx];
        if (id !== undefined) {
          const d = await deleteJson(transport, nodePath(basePath, cid, id));
          if (!d.ok) return d;
          removed += 1;
        }
        ids.splice(idx, 1);
      }
      const newHead = ids.length > 0 ? (ids[ids.length - 1] ?? null) : null;
      const wm = await writeMeta(cid, { headNodeId: newHead, nodeIds: ids });
      if (!wm.ok) return wm;
      return { ok: true, value: removed };
    });
  };

  const close = (): void => {
    transport.close();
  };

  return { put, get, head, list, ancestors, fork, prune, close };
}
