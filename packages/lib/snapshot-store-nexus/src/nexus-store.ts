/**
 * Nexus-backed `SnapshotChainStore<T>`.
 *
 * Three-tier layout:
 *   <basePath>/_nodes/<nodeId>.json              — canonical node payload (one per nodeId)
 *   <basePath>/<chainId>/members/<nodeId>.member — membership marker (chain ↔ nodeId)
 *   <basePath>/<chainId>/meta.json              — head pointer + nodeIds list
 *
 * Node files are chain-independent: forking a chain copies membership markers only,
 * not canonical node files. This ensures nodeIds are globally unique and all
 * ancestor nodes remain reachable after a fork. Per-chain mutex serializes
 * meta read-modify-write within a single process.
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
import { internal, nodeId as makeNodeId, notFound, validation } from "@koi/core";
import { computeContentHash } from "@koi/hash";
import { deleteJson, exists, listChildren, readJson, writeJson } from "./json-io.js";
import { getCanonicalMutexBox, getChainLockMap } from "./locks.js";
import { canonicalNodePath, memberPath, metaPath, validateSegment } from "./paths.js";
import type { NexusSnapshotStoreConfig } from "./types.js";

interface ChainMeta {
  readonly headNodeId: NodeId | null;
  readonly nodeIds: readonly NodeId[];
}

const EMPTY_META: ChainMeta = { headNodeId: null, nodeIds: [] };
const EMPTY_MEMBER_BODY = {};

const DEFAULT_BASE_PATH = "snapshots";

export function createSnapshotStoreNexus<T>(
  config: NexusSnapshotStoreConfig,
): SnapshotChainStore<T> {
  const basePath = config.basePath ?? DEFAULT_BASE_PATH;
  const transport = config.transport;
  // Derive the effective lock scope. Two stores pointing at the same backend
  // via DIFFERENT transport objects (e.g. decorator wrappers) share a pool
  // when they supply the same lockScope. Default: basePath — safe when each
  // basePath maps to exactly one backend in a given process.
  const scope = config.lockScope ?? basePath;
  // Module-level lock pools shared across all instances with the same scope.
  // See locks.ts for the full design rationale.
  const chainLocks = getChainLockMap(scope);
  const canonicalMutexBox = getCanonicalMutexBox(scope);

  /**
   * Canonical-mutation mutex — serialises the two phases that must be atomic
   * with respect to each other:
   *
   *   fork's marker-write phase: writes target membership markers that protect
   *     the canonical files from GC.
   *   prune's canonical-delete phase: checks whether any other chain still holds
   *     a marker before deleting the canonical file.
   *
   * Without this mutex the race is:
   *   1. fork reads ancestor list.
   *   2. prune deletes source membership marker + finds no other markers (fork
   *      hasn't written its target markers yet) → deletes canonical file.
   *   3. fork writes target markers + meta — canonical is already gone.
   *
   * Both phases must hold this mutex while they execute. Either fork finishes
   * writing its markers first (so prune sees them and skips the canonical
   * delete), or prune deletes the canonical first (so fork's post-write
   * verification detects the race and fails with INTERNAL).
   *
   * The mutex box is module-level (shared across instances with the same
   * transport + basePath) so cross-instance races are also serialised.
   */
  async function withCanonicalMutex<R>(fn: () => Promise<R>): Promise<R> {
    // let is justified: release must be assigned inside the Promise constructor callback
    let release = (): void => {};
    const ticket = new Promise<void>((resolve) => {
      release = resolve;
    });
    const prev = canonicalMutexBox.current;
    canonicalMutexBox.current = ticket;
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  async function readMeta(cid: ChainId): Promise<Result<ChainMeta, KoiError>> {
    const r = await readJson<ChainMeta>(transport, metaPath(basePath, cid));
    if (!r.ok) return r;
    if (r.value === undefined) return { ok: true, value: EMPTY_META };
    return { ok: true, value: r.value };
  }

  async function writeMeta(cid: ChainId, meta: ChainMeta): Promise<Result<void, KoiError>> {
    return writeJson(transport, metaPath(basePath, cid), meta);
  }

  /** Read a node by nodeId from the canonical store (chain-independent). */
  async function readNode(nid: NodeId): Promise<Result<SnapshotNode<T>, KoiError>> {
    const r = await readJson<SnapshotNode<T>>(transport, canonicalNodePath(basePath, nid));
    if (!r.ok) return r;
    if (r.value === undefined) {
      return { ok: false, error: notFound(nid, `Snapshot node not found: ${nid}`) };
    }
    return { ok: true, value: r.value };
  }

  /** Write a node to the canonical store (path is chain-independent). */
  async function writeNode(node: SnapshotNode<T>): Promise<Result<void, KoiError>> {
    return writeJson(transport, canonicalNodePath(basePath, node.nodeId), node);
  }

  /** Write a membership marker linking nodeId to chainId. */
  async function writeMember(cid: ChainId, nid: NodeId): Promise<Result<void, KoiError>> {
    return writeJson(transport, memberPath(basePath, cid, nid), EMPTY_MEMBER_BODY);
  }

  /**
   * Check whether any chain OTHER than `excludingChainId` holds a membership
   * marker for `nid`. Used by prune to decide whether to delete the canonical
   * node file.
   *
   * Pattern: basePath/asterisk/members/nodeId.member
   * The _nodes directory never has a members/ subdir, so it is not matched.
   */
  async function findOtherChainMembers(
    nid: NodeId,
    excludingChainId: ChainId,
  ): Promise<Result<readonly string[], KoiError>> {
    const pattern = `${basePath}/*/members/${nid}.member`;
    const lr = await listChildren(transport, pattern);
    if (!lr.ok) return lr;
    // Filter out the marker we just deleted (or are about to delete) for excludingChainId.
    const others = lr.value.filter((p) => !p.includes(`/${excludingChainId}/`));
    return { ok: true, value: others };
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
    // Parent existence check is inside withChainLock so a concurrent in-process
    // prune cannot delete a parent between validation and the child write.
    // We check BOTH the membership marker AND the chain meta nodeIds array:
    //   - Marker check: fast membership signal; pruned nodes lose their marker.
    //   - Meta check: authoritative chain membership; guards against partial-prune
    //     failure where meta was written (removing the nodeId) but marker deletion
    //     failed, leaving an orphaned marker that would otherwise pass the marker check.
    return withChainLock(cid, async () => {
      const hash = computeContentHash(data);
      const metaRes = await readMeta(cid);
      if (!metaRes.ok) return metaRes;
      const meta = metaRes.value;
      const metaNodeIdSet = new Set<NodeId>(meta.nodeIds);

      for (const pid of parentIds) {
        // Check meta first (authoritative): nodeIds is the definitive membership
        // list. A pruned parent is removed from nodeIds before markers are deleted,
        // so a partial-prune failure (marker survives, nodeId gone) is caught here.
        if (!metaNodeIdSet.has(pid)) {
          return { ok: false, error: validation(`Parent node not found: ${pid}`) };
        }
        // Defense-in-depth: also check the membership marker file.
        const ex = await exists(transport, memberPath(basePath, cid, pid));
        if (!ex.ok) return ex;
        if (!ex.value) return { ok: false, error: validation(`Parent node not found: ${pid}`) };
      }

      if (options?.skipIfUnchanged === true && meta.headNodeId !== null) {
        const head = await readNode(meta.headNodeId);
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
      // Write canonical node first, then membership marker, then meta.
      // Order: data durable before pointer updates (Fix 4 invariant).
      const wn = await writeNode(node);
      if (!wn.ok) return wn;
      const wmbr = await writeMember(cid, nid);
      if (!wmbr.ok) return wmbr;
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
    // Single canonical resolution — no wildcard glob needed.
    return readNode(nid);
  };

  const head: SnapshotChainStore<T>["head"] = async (
    cid,
  ): Promise<Result<SnapshotNode<T> | undefined, KoiError>> => {
    const seg = validateSegment(cid, "Chain ID");
    if (!seg.ok) return { ok: false, error: seg.error };
    const m = await readMeta(cid);
    if (!m.ok) return m;
    if (m.value.headNodeId === null) return { ok: true, value: undefined };
    return readNode(m.value.headNodeId);
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
      const r = await readNode(id);
      if (r.ok) {
        out.push(r.value);
      } else if (r.error.code !== "NOT_FOUND") {
        // Propagate unexpected errors (EXTERNAL, INTERNAL, etc.).
        // NOT_FOUND is tolerated: a concurrent prune can race a stale meta read.
        return r;
      }
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
        if (pr.ok) {
          queue.push([pr.value, depth + 1]);
        } else if (pr.error.code === "NOT_FOUND") {
          // A missing parent means the DAG has a dangling edge — this indicates
          // corruption (child references a parent that no longer exists).
          return {
            ok: false,
            error: internal(`ancestors: dangling parent edge: ${pid}`),
          };
        } else {
          // EXTERNAL, INTERNAL, or other errors — propagate directly.
          return pr;
        }
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

    // Source node must exist in the canonical store.
    const src = await get(sourceNodeId);
    if (!src.ok) return src;

    // Compute the full ancestor closure (includes the source node at index 0).
    const ancestorsRes = await ancestors({ startNodeId: sourceNodeId });
    if (!ancestorsRes.ok) return ancestorsRes;

    // ancestorsRes.value is ordered depth-ascending (source first, oldest last).
    // Reverse to oldest-first so meta.nodeIds matches insertion order (oldest → newest).
    const ancestorList = [...ancestorsRes.value].reverse();

    // Wrap target-chain mutations in the target chain lock.
    // This serialises concurrent fork + put calls on the same target chain and
    // ensures the non-empty check is atomic with the write.
    return withChainLock(newChainId, async () => {
      // Reject non-empty target chains: forking into an existing populated chain
      // would overwrite its head pointer and orphan its history.
      const existingMeta = await readMeta(newChainId);
      if (!existingMeta.ok) return existingMeta;
      if (existingMeta.value.headNodeId !== null) {
        return {
          ok: false,
          error: validation(`Cannot fork into non-empty chain ${newChainId}`),
        };
      }

      // Write membership markers + meta under the canonical mutex so prune's
      // canonical-delete phase cannot race the marker writes: either prune sees
      // the new markers (and skips the canonical delete) or it deletes the
      // canonical before we enter the mutex (caught by the existence check below).
      return withCanonicalMutex(async () => {
        // Pre-write verification: if a concurrent prune already deleted a canonical
        // before we enter the mutex, reject now without touching the target chain.
        for (const node of ancestorList) {
          const ex = await exists(transport, canonicalNodePath(basePath, node.nodeId));
          if (!ex.ok) return ex;
          if (!ex.value) {
            return {
              ok: false,
              error: internal(`fork: source canonical deleted concurrently: ${node.nodeId}`),
            };
          }
        }

        // Write membership markers for every ancestor — do NOT touch canonical files.
        const writtenMarkers: string[] = [];
        for (const node of ancestorList) {
          const wm = await writeMember(newChainId, node.nodeId);
          if (!wm.ok) return wm;
          writtenMarkers.push(memberPath(basePath, newChainId, node.nodeId));
        }

        // Write meta last: pointers after data is durable.
        const nodeIds = ancestorList.map((n) => n.nodeId);
        const metaWritePath = metaPath(basePath, newChainId);
        const wm = await writeMeta(newChainId, {
          headNodeId: sourceNodeId,
          nodeIds,
        });
        if (!wm.ok) return wm;

        // Post-write defense-in-depth: if a concurrent prune somehow deleted a
        // canonical in the tiny window between our pre-write check and the marker
        // writes, roll back everything we wrote to leave the target chain empty.
        for (const node of ancestorList) {
          const ex = await exists(transport, canonicalNodePath(basePath, node.nodeId));
          if (!ex.ok) return ex;
          if (!ex.value) {
            // Roll back: delete every marker we wrote, then delete the meta.
            const leaks: string[] = [];
            for (const markerPath of writtenMarkers) {
              const d = await deleteJson(transport, markerPath);
              if (!d.ok) leaks.push(markerPath);
            }
            const dm = await deleteJson(transport, metaWritePath);
            if (!dm.ok) leaks.push(metaWritePath);
            const leakMsg = leaks.length > 0 ? ` (rollback leaked: ${leaks.join(", ")})` : "";
            return {
              ok: false,
              error: internal(
                `fork: canonical node deleted during fork (race detected): ${node.nodeId}${leakMsg}`,
              ),
            };
          }
        }

        const ref: ForkRef = { parentNodeId: sourceNodeId, label };
        return { ok: true, value: ref };
      });
    });
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
          const node = await readNode(id);
          if (node.ok) {
            if (node.value.createdAt < cutoff) remove.add(i);
          } else if (node.error.code === "NOT_FOUND") {
            // A listed node that doesn't exist is a dangling meta entry —
            // meta should never reference a node that has been deleted.
            // Propagate as INTERNAL so the caller can detect and recover.
            return {
              ok: false,
              error: internal(`prune: dangling meta entry for ${id}`),
            };
          } else {
            // EXTERNAL, INTERNAL, or other transport errors — propagate directly.
            return node;
          }
        }
      }
      if (policy.retainBranches !== false) remove.delete(ids.length - 1);

      // Compute the post-prune node list and write meta FIRST.
      // A partial failure leaves orphan markers (recoverable / harmless) rather
      // than meta that references already-deleted membership markers.
      const postPruneIds = ids.filter((_, i) => !remove.has(i));
      const newHead =
        postPruneIds.length > 0 ? (postPruneIds[postPruneIds.length - 1] ?? null) : null;
      const wm = await writeMeta(cid, { headNodeId: newHead, nodeIds: postPruneIds });
      if (!wm.ok) return wm;

      // Delete membership markers for removed nodeIds, then delete the canonical
      // node file if no other chain holds a marker for that node.
      // The canonical-delete phase runs under the canonical mutex to prevent a
      // concurrent fork from writing target markers after we check for other
      // chain members but before we delete the canonical file.
      const sorted = [...remove].sort((a, b) => b - a);
      let removed = 0;
      for (const idx of sorted) {
        const id = ids[idx];
        if (id === undefined) continue;
        // Delete the membership marker for this chain first.
        const d = await deleteJson(transport, memberPath(basePath, cid, id));
        if (!d.ok) return d;
        removed += 1;
        // Hold the canonical mutex while checking and conditionally deleting the
        // canonical file. This prevents fork from writing new markers for this
        // node between our findOtherChainMembers check and the canonical delete.
        const deleteResult = await withCanonicalMutex(async () => {
          // Re-check: a concurrent fork may have written a new marker since we
          // deleted our marker above.
          const others = await findOtherChainMembers(id, cid);
          if (!others.ok) return others;
          if (others.value.length === 0) {
            return deleteJson(transport, canonicalNodePath(basePath, id));
          }
          return { ok: true, value: undefined } as Result<void, KoiError>;
        });
        if (!deleteResult.ok) return deleteResult;
      }
      return { ok: true, value: removed };
    });
  };

  const close = (): void => {
    transport.close();
  };

  return { put, get, head, list, ancestors, fork, prune, close };
}
