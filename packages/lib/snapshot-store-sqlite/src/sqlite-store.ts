/**
 * SQLite-backed `SnapshotChainStore<T>` factory.
 *
 * Ports the v1 SQLite chain store from `archive/v1/packages/mm/snapshot-chain-store/`
 * with three changes per the #1625 design review:
 *
 * 1. Recursive CTE for ancestor walks (replaces v1 BFS-with-N+1 queries)
 * 2. Mark-and-sweep blob GC integrated into `prune` (v1 left this to callers)
 * 3. `parent_ids` stored as a JSON array column on `snapshot_nodes` rather
 *    than a separate `snapshot_parents` bridge table (so the CTE can use
 *    `json_each` in a single query)
 *
 * This file holds the wiring (statement preparation, in-memory caches,
 * factory closure). The recursive CTE lives in `cte.ts` and the blob sweeper
 * lives in `gc.ts`.
 */

import { Database } from "bun:sqlite";
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
import { internal, notFound, validation } from "@koi/core";
import { computeContentHash } from "@koi/hash";
import { walkAncestors } from "./cte.js";
import { sweepOrphanBlobs } from "./gc.js";
import { applyPragmas, applySchema } from "./schema.js";
import type { SqliteSnapshotStoreConfig } from "./types.js";

// ---------------------------------------------------------------------------
// Sync narrowing
// ---------------------------------------------------------------------------

/**
 * Mapped type that narrows every method on a `SnapshotChainStore<T>` from
 * its L0 sync-or-async return type (`R | Promise<R>`) to the sync-only `R`.
 *
 * The L0 interface uses unions so adapters can be sync (in-memory, SQLite)
 * or async (network) without changing the interface. This SQLite adapter is
 * always sync, so the factory advertises that fact at the type level —
 * callers and tests don't need `await` (though they may add it for L0
 * portability).
 */
type SyncOps<T> = {
  readonly [K in keyof T]: T[K] extends (...args: infer A) => infer R
    ? (...args: A) => Awaited<R>
    : T[K];
};

/** Sync-narrowed view of `SnapshotChainStore<T>`. */
export type SqliteSnapshotStore<T> = SyncOps<SnapshotChainStore<T>>;

// ---------------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------------

interface NodeRow {
  readonly node_id: string;
  readonly chain_id: string;
  readonly parent_ids: string;
  readonly content_hash: string;
  readonly data: string;
  readonly created_at: number;
  readonly metadata: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function generateNodeId(): NodeId {
  return `node-${crypto.randomUUID()}` as NodeId;
}

function rowToNode<T>(row: NodeRow): SnapshotNode<T> {
  return {
    nodeId: row.node_id as NodeId,
    chainId: row.chain_id as ChainId,
    parentIds: (JSON.parse(row.parent_ids) as readonly string[]).map((p) => p as NodeId),
    contentHash: row.content_hash,
    data: JSON.parse(row.data) as T,
    createdAt: row.created_at,
    metadata: JSON.parse(row.metadata) as Readonly<Record<string, unknown>>,
  };
}

function sqlError(e: unknown, context: string): { readonly ok: false; readonly error: KoiError } {
  return { ok: false, error: internal(`snapshot-store-sqlite: ${context}`, e) };
}

// ---------------------------------------------------------------------------
// Public factory
// ---------------------------------------------------------------------------

/**
 * Create a SQLite-backed `SnapshotChainStore<T>`.
 *
 * Generic over the payload type `T`. If `blobDir` and `extractBlobRefs` are
 * both provided, `prune()` runs mark-and-sweep blob GC against the directory.
 */
export function createSnapshotStoreSqlite<T>(
  config: SqliteSnapshotStoreConfig<T>,
): SqliteSnapshotStore<T> {
  const db = new Database(config.path, { create: true });
  applyPragmas(db, config.durability ?? "process");
  applySchema(db);

  // -- Prepared statements --------------------------------------------------

  const insertNodeStmt = db.prepare(`
    INSERT INTO snapshot_nodes (node_id, chain_id, parent_ids, content_hash, data, created_at, metadata)
    VALUES ($node_id, $chain_id, $parent_ids, $content_hash, $data, $created_at, $metadata)
  `);

  const insertMemberStmt = db.prepare(`
    INSERT OR IGNORE INTO chain_members (chain_id, node_id, created_at, seq)
    VALUES ($chain_id, $node_id, $created_at, $seq)
  `);

  const upsertHeadStmt = db.prepare(`
    INSERT INTO chain_heads (chain_id, node_id) VALUES ($chain_id, $node_id)
    ON CONFLICT(chain_id) DO UPDATE SET node_id = excluded.node_id
  `);

  const selectNodeStmt = db.query<NodeRow, [string]>(
    "SELECT * FROM snapshot_nodes WHERE node_id = ?",
  );

  const selectChainNodesStmt = db.query<NodeRow, [string]>(
    `SELECT n.* FROM snapshot_nodes n
     INNER JOIN chain_members m ON n.node_id = m.node_id
     WHERE m.chain_id = ?
     ORDER BY m.created_at DESC, m.seq DESC`,
  );

  const selectNewestSurvivorStmt = db.query<{ readonly node_id: string }, [string]>(
    `SELECT node_id FROM chain_members
     WHERE chain_id = ?
     ORDER BY created_at DESC, seq DESC
     LIMIT 1`,
  );

  const deleteMemberStmt = db.prepare(
    "DELETE FROM chain_members WHERE chain_id = ? AND node_id = ?",
  );

  const countMemberRefsStmt = db.query<{ readonly cnt: number }, [string]>(
    "SELECT COUNT(*) AS cnt FROM chain_members WHERE node_id = ?",
  );

  const deleteNodeStmt = db.prepare("DELETE FROM snapshot_nodes WHERE node_id = ?");
  const deleteHeadStmt = db.prepare("DELETE FROM chain_heads WHERE chain_id = ?");

  // -- In-memory caches -----------------------------------------------------

  // chain head pointer cache: chainId → nodeId. Initialized from chain_heads
  // at construction; updated on put/fork/prune so head() is O(1) lookup
  // followed by a single indexed SELECT on snapshot_nodes.
  const chainHeads = new Map<string, string>();
  const initHeadRows = db
    .query<{ readonly chain_id: string; readonly node_id: string }, []>(
      "SELECT chain_id, node_id FROM chain_heads",
    )
    .all();
  for (const row of initHeadRows) {
    chainHeads.set(row.chain_id, row.node_id);
  }

  // Per-chain seq counter for deterministic ordering within the same ms.
  // Initialized from chain_members on construction.
  const chainSeqs = new Map<string, number>();
  const initSeqRows = db
    .query<{ readonly chain_id: string; readonly max_seq: number }, []>(
      "SELECT chain_id, MAX(seq) AS max_seq FROM chain_members GROUP BY chain_id",
    )
    .all();
  for (const row of initSeqRows) {
    chainSeqs.set(row.chain_id, row.max_seq);
  }

  function nextSeq(cid: string): number {
    const current = chainSeqs.get(cid) ?? -1;
    const next = current + 1;
    chainSeqs.set(cid, next);
    return next;
  }

  let closed = false;

  function ensureOpen(): void {
    if (closed) {
      throw new Error("snapshot-store-sqlite: store is closed");
    }
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
    try {
      ensureOpen();

      // Validate parent IDs exist before computing the content hash so a
      // bad input fails fast without doing extra work.
      for (const pid of parentIds) {
        const row = selectNodeStmt.get(pid);
        if (row === null) {
          return {
            ok: false,
            error: validation(`Parent node not found: ${pid}`),
          };
        }
      }

      const hash = computeContentHash(data);

      // skipIfUnchanged: if the head's content hash matches, return the
      // current head without writing. Caller treats `value === undefined`
      // as "no change, your existing reference is still current".
      if (options?.skipIfUnchanged === true) {
        const headNodeId = chainHeads.get(cid);
        if (headNodeId !== undefined) {
          const headRow = selectNodeStmt.get(headNodeId);
          if (headRow !== null && headRow.content_hash === hash) {
            return { ok: true, value: undefined };
          }
        }
      }

      const nid = generateNodeId();
      const now = Date.now();
      const seq = nextSeq(cid);

      db.transaction(() => {
        insertNodeStmt.run({
          $node_id: nid,
          $chain_id: cid,
          $parent_ids: JSON.stringify(parentIds),
          $content_hash: hash,
          $data: JSON.stringify(data),
          $created_at: now,
          $metadata: JSON.stringify(metadata ?? {}),
        });
        insertMemberStmt.run({
          $chain_id: cid,
          $node_id: nid,
          $created_at: now,
          $seq: seq,
        });
        upsertHeadStmt.run({ $chain_id: cid, $node_id: nid });
      })();

      chainHeads.set(cid, nid);

      const node: SnapshotNode<T> = {
        nodeId: nid,
        chainId: cid,
        parentIds: [...parentIds],
        contentHash: hash,
        data,
        createdAt: now,
        metadata: metadata ?? {},
      };

      return { ok: true, value: node };
    } catch (e: unknown) {
      return sqlError(e, "put");
    }
  };

  // -----------------------------------------------------------------------
  // get
  // -----------------------------------------------------------------------

  const getNode = (nid: NodeId): Result<SnapshotNode<T>, KoiError> => {
    try {
      ensureOpen();
      const row = selectNodeStmt.get(nid);
      if (row === null) {
        return {
          ok: false,
          error: notFound(nid, `Snapshot node not found: ${nid}`),
        };
      }
      return { ok: true, value: rowToNode<T>(row) };
    } catch (e: unknown) {
      return sqlError(e, "get");
    }
  };

  // -----------------------------------------------------------------------
  // head
  // -----------------------------------------------------------------------

  const head = (cid: ChainId): Result<SnapshotNode<T> | undefined, KoiError> => {
    try {
      ensureOpen();
      const headNodeId = chainHeads.get(cid);
      if (headNodeId === undefined) {
        return { ok: true, value: undefined };
      }
      const row = selectNodeStmt.get(headNodeId);
      if (row === null) {
        // Cache and DB disagree — should not happen, but tolerate it.
        chainHeads.delete(cid);
        return { ok: true, value: undefined };
      }
      return { ok: true, value: rowToNode<T>(row) };
    } catch (e: unknown) {
      return sqlError(e, "head");
    }
  };

  // -----------------------------------------------------------------------
  // list
  // -----------------------------------------------------------------------

  const list = (cid: ChainId): Result<readonly SnapshotNode<T>[], KoiError> => {
    try {
      ensureOpen();
      const rows = selectChainNodesStmt.all(cid);
      return { ok: true, value: rows.map((r) => rowToNode<T>(r)) };
    } catch (e: unknown) {
      return sqlError(e, "list");
    }
  };

  // -----------------------------------------------------------------------
  // ancestors (recursive CTE — see cte.ts)
  // -----------------------------------------------------------------------

  const ancestors = (query: AncestorQuery): Result<readonly SnapshotNode<T>[], KoiError> => {
    try {
      ensureOpen();

      // Verify the start node exists so we return NOT_FOUND instead of an
      // empty list when the caller passes a bad ID.
      const startRow = selectNodeStmt.get(query.startNodeId);
      if (startRow === null) {
        return {
          ok: false,
          error: notFound(query.startNodeId, `Start node not found: ${query.startNodeId}`),
        };
      }

      const ancestorRows = walkAncestors(db, query.startNodeId, query.maxDepth);
      const result = ancestorRows.map((r) =>
        rowToNode<T>({
          node_id: r.node_id,
          chain_id: r.chain_id,
          parent_ids: r.parent_ids,
          content_hash: r.content_hash,
          data: r.data,
          created_at: r.created_at,
          metadata: r.metadata,
        }),
      );
      return { ok: true, value: result };
    } catch (e: unknown) {
      return sqlError(e, "ancestors");
    }
  };

  // -----------------------------------------------------------------------
  // fork
  // -----------------------------------------------------------------------

  const fork = (
    sourceNodeId: NodeId,
    newChainId: ChainId,
    label: string,
  ): Result<ForkRef, KoiError> => {
    try {
      ensureOpen();
      const sourceRow = selectNodeStmt.get(sourceNodeId);
      if (sourceRow === null) {
        return {
          ok: false,
          error: notFound(sourceNodeId, `Source node not found: ${sourceNodeId}`),
        };
      }

      const seq = nextSeq(newChainId);

      db.transaction(() => {
        insertMemberStmt.run({
          $chain_id: newChainId,
          $node_id: sourceNodeId,
          $created_at: sourceRow.created_at,
          $seq: seq,
        });
        upsertHeadStmt.run({ $chain_id: newChainId, $node_id: sourceNodeId });
      })();

      chainHeads.set(newChainId, sourceNodeId);

      return { ok: true, value: { parentNodeId: sourceNodeId, label } };
    } catch (e: unknown) {
      return sqlError(e, "fork");
    }
  };

  // -----------------------------------------------------------------------
  // prune (chain prune + mark-and-sweep blob GC)
  // -----------------------------------------------------------------------

  const prune = (cid: ChainId, policy: PruningPolicy): Result<number, KoiError> => {
    try {
      ensureOpen();
      const rows = selectChainNodesStmt.all(cid);
      if (rows.length === 0) {
        return { ok: true, value: 0 };
      }

      const now = Date.now();
      const toRemove = new Set<number>();

      // retainCount: keep the newest N (rows are newest-first), drop the rest.
      if (policy.retainCount !== undefined && rows.length > policy.retainCount) {
        for (let i = policy.retainCount; i < rows.length; i++) {
          toRemove.add(i);
        }
      }

      // retainDuration: drop nodes older than the cutoff.
      if (policy.retainDuration !== undefined) {
        const cutoff = now - policy.retainDuration;
        for (let i = 0; i < rows.length; i++) {
          const row = rows[i];
          if (row !== undefined && row.created_at < cutoff) {
            toRemove.add(i);
          }
        }
      }

      // Protect head if retainBranches !== false (default true). Index 0 is
      // the newest = the chain head.
      if (policy.retainBranches !== false) {
        toRemove.delete(0);
      }

      let removedCount = 0;

      db.transaction(() => {
        for (const idx of toRemove) {
          const row = rows[idx];
          if (row === undefined) continue;
          const nid = row.node_id;

          // Drop this chain's membership for the node.
          deleteMemberStmt.run(cid, nid);

          // If no other chain references the node, delete it entirely so
          // mark-and-sweep can pick up its blobs.
          const refRow = countMemberRefsStmt.get(nid);
          const totalRefs = refRow?.cnt ?? 0;
          if (totalRefs === 0) {
            deleteNodeStmt.run(nid);
          }

          removedCount += 1;
        }

        // Update head pointer if it changed:
        // - all members removed → drop head row
        // - head member removed → point to newest survivor (or drop)
        if (removedCount === rows.length) {
          deleteHeadStmt.run(cid);
          chainHeads.delete(cid);
        } else if (toRemove.has(0)) {
          const newHeadRow = selectNewestSurvivorStmt.get(cid);
          if (newHeadRow !== null) {
            upsertHeadStmt.run({ $chain_id: cid, $node_id: newHeadRow.node_id });
            chainHeads.set(cid, newHeadRow.node_id);
          } else {
            deleteHeadStmt.run(cid);
            chainHeads.delete(cid);
          }
        }
      })();

      // Mark-and-sweep blob GC. Runs OUTSIDE the transaction because
      // filesystem ops cannot be rolled back by SQL. Idempotent — a crash
      // mid-sweep just leaves orphan blobs for the next prune to clean up.
      if (config.blobDir !== undefined && config.extractBlobRefs !== undefined) {
        sweepOrphanBlobs(db, config.blobDir, config.extractBlobRefs);
      }

      return { ok: true, value: removedCount };
    } catch (e: unknown) {
      return sqlError(e, "prune");
    }
  };

  // -----------------------------------------------------------------------
  // close
  // -----------------------------------------------------------------------

  const close = (): void => {
    if (closed) return;
    closed = true;
    chainHeads.clear();
    chainSeqs.clear();
    db.close();
  };

  return {
    put,
    get: getNode,
    head,
    list,
    ancestors,
    fork,
    prune,
    close,
  };
}
