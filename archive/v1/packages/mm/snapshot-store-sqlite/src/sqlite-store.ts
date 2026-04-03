/**
 * SQLite-backed SnapshotChainStore<T> — persistent DAG snapshot storage.
 *
 * Uses bun:sqlite with WAL mode. Supports full DAG topology,
 * content-hash deduplication, ancestor walking, forking, and pruning.
 * Heads are tracked in-memory for O(1) lookup, initialized from DB on construction.
 *
 * A node's chain membership is tracked in a separate `chain_members` table
 * so that a single node can belong to multiple chains (via fork).
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
import { mapSqliteError, openDb } from "@koi/sqlite-utils";
import type { SqliteSnapshotStoreConfig } from "./types.js";

// ---------------------------------------------------------------------------
// Row type for SELECT queries
// ---------------------------------------------------------------------------

interface SnapshotRow {
  readonly node_id: string;
  readonly parent_ids: string;
  readonly content_hash: string;
  readonly data: string;
  readonly created_at: number;
  readonly metadata: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function rowToNode<T>(row: SnapshotRow, cid: ChainId): SnapshotNode<T> {
  return {
    nodeId: row.node_id as NodeId,
    chainId: cid,
    parentIds: JSON.parse(row.parent_ids) as readonly NodeId[],
    contentHash: row.content_hash,
    data: JSON.parse(row.data) as T,
    createdAt: row.created_at,
    metadata: JSON.parse(row.metadata) as Readonly<Record<string, unknown>>,
  };
}

function generateNodeId(): NodeId {
  return `node-${crypto.randomUUID()}` as NodeId;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function createSqliteSnapshotStore<T>(
  config: SqliteSnapshotStoreConfig,
): SnapshotChainStore<T> & { readonly close: () => void } {
  const tbl = config.tableName ?? "snapshot_nodes";
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(tbl)) {
    throw new Error(`Invalid table name: ${tbl}`);
  }
  const memberTbl = `${tbl}_members`;
  const db = openDb(config.dbPath);

  // Override synchronous if "os" durability requested
  if (config.durability === "os") {
    db.run("PRAGMA synchronous = FULL");
  }

  // -- Schema ---------------------------------------------------------------
  db.run(`
    CREATE TABLE IF NOT EXISTS ${tbl} (
      node_id       TEXT PRIMARY KEY,
      parent_ids    TEXT NOT NULL DEFAULT '[]',
      content_hash  TEXT NOT NULL,
      data          TEXT NOT NULL,
      created_at    INTEGER NOT NULL,
      metadata      TEXT NOT NULL DEFAULT '{}'
    )
  `);

  // Chain membership — a node can belong to multiple chains via fork.
  // seq is a per-chain monotonic counter for deterministic ordering within the same ms.
  db.run(`
    CREATE TABLE IF NOT EXISTS ${memberTbl} (
      chain_id    TEXT NOT NULL,
      node_id     TEXT NOT NULL,
      created_at  INTEGER NOT NULL,
      seq         INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (chain_id, node_id)
    )
  `);
  db.run(
    `CREATE INDEX IF NOT EXISTS idx_${memberTbl}_chain ON ${memberTbl}(chain_id, created_at DESC, seq DESC)`,
  );

  // -- Prepared statements --------------------------------------------------
  const insertNodeStmt = db.prepare(`
    INSERT INTO ${tbl} (node_id, parent_ids, content_hash, data, created_at, metadata)
    VALUES ($node_id, $parent_ids, $content_hash, $data, $created_at, $metadata)
  `);

  const insertMemberStmt = db.prepare(`
    INSERT OR IGNORE INTO ${memberTbl} (chain_id, node_id, created_at, seq)
    VALUES ($chain_id, $node_id, $created_at, $seq)
  `);

  const selectByIdStmt = db.query<SnapshotRow, [string]>(`SELECT * FROM ${tbl} WHERE node_id = ?`);

  const selectByChainStmt = db.query<SnapshotRow, [string]>(
    `SELECT n.* FROM ${tbl} n
     INNER JOIN ${memberTbl} m ON n.node_id = m.node_id
     WHERE m.chain_id = ?
     ORDER BY m.created_at DESC, m.seq DESC`,
  );

  const deleteMemberStmt = db.prepare(
    `DELETE FROM ${memberTbl} WHERE chain_id = ? AND node_id = ?`,
  );

  const countRefsStmt = db.query<{ readonly cnt: number }, [string]>(
    `SELECT COUNT(*) as cnt FROM ${memberTbl} WHERE node_id = ?`,
  );

  const deleteNodeStmt = db.prepare(`DELETE FROM ${tbl} WHERE node_id = ?`);

  const selectChainByNodeStmt = db.query<{ readonly chain_id: string }, [string]>(
    `SELECT chain_id FROM ${memberTbl} WHERE node_id = ? LIMIT 1`,
  );

  const selectHeadByChainStmt = db.query<
    { readonly node_id: string; readonly seq: number },
    [string]
  >(
    `SELECT node_id, seq FROM ${memberTbl} WHERE chain_id = ? ORDER BY created_at DESC, seq DESC LIMIT 1`,
  );

  // -- In-memory head tracking + seq counters ---------------------------------
  const chainHeads = new Map<string, string>();
  const chainSeqs = new Map<string, number>();

  // Initialize heads and seq counters from DB
  const initRows = db
    .query<{ readonly chain_id: string; readonly node_id: string; readonly max_seq: number }, []>(
      `SELECT chain_id, node_id, max_seq FROM ${memberTbl} m
       INNER JOIN (
         SELECT chain_id AS cid, MAX(seq) AS max_seq FROM ${memberTbl} GROUP BY chain_id
       ) latest ON m.chain_id = latest.cid AND m.seq = latest.max_seq`,
    )
    .all();
  for (const row of initRows) {
    chainHeads.set(row.chain_id, row.node_id);
    chainSeqs.set(row.chain_id, row.max_seq);
  }

  let closed = false;

  const CLOSED_ERROR: KoiError = {
    code: "INTERNAL",
    message: "Store is closed",
    retryable: false,
  };

  function assertOpen(): { readonly ok: false; readonly error: KoiError } | undefined {
    if (closed) {
      return { ok: false, error: CLOSED_ERROR };
    }
    return undefined;
  }

  function sqlError(e: unknown, context: string): { readonly ok: false; readonly error: KoiError } {
    return { ok: false, error: mapSqliteError(e, context) };
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
    const closedCheck = assertOpen();
    if (closedCheck !== undefined) return closedCheck;

    try {
      // Validate parent IDs exist
      for (const pid of parentIds) {
        const row = selectByIdStmt.get(pid);
        if (row === null) {
          return { ok: false, error: validation(`Parent node not found: ${pid}`) };
        }
      }

      const hash = computeContentHash(data);

      // Check skipIfUnchanged
      if (options?.skipIfUnchanged === true) {
        const headId = chainHeads.get(cid);
        if (headId !== undefined) {
          const headRow = selectByIdStmt.get(headId);
          if (headRow !== null && headRow.content_hash === hash) {
            return { ok: true, value: undefined };
          }
        }
      }

      const nid = generateNodeId();
      const now = Date.now();
      const nextSeq = (chainSeqs.get(cid) ?? -1) + 1;

      db.transaction(() => {
        insertNodeStmt.run({
          $node_id: nid,
          $parent_ids: JSON.stringify(parentIds),
          $content_hash: hash,
          $data: JSON.stringify(data),
          $created_at: now,
          $metadata: JSON.stringify(metadata ?? {}),
        });
        insertMemberStmt.run({ $chain_id: cid, $node_id: nid, $created_at: now, $seq: nextSeq });
      })();

      chainHeads.set(cid, nid);
      chainSeqs.set(cid, nextSeq);

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
    const closedCheck = assertOpen();
    if (closedCheck !== undefined) return closedCheck;

    try {
      const row = selectByIdStmt.get(nid);
      if (row === null) {
        return { ok: false, error: notFound(nid, `Snapshot node not found: ${nid}`) };
      }
      // For get(), return the node with its first chain membership
      const memberRow = selectChainByNodeStmt.get(nid);
      const cid = (memberRow?.chain_id ?? "") as ChainId;
      return { ok: true, value: rowToNode<T>(row, cid) };
    } catch (e: unknown) {
      return sqlError(e, "get");
    }
  };

  // -----------------------------------------------------------------------
  // head
  // -----------------------------------------------------------------------

  const head = (cid: ChainId): Result<SnapshotNode<T> | undefined, KoiError> => {
    const closedCheck = assertOpen();
    if (closedCheck !== undefined) return closedCheck;

    const headId = chainHeads.get(cid);
    if (headId === undefined) {
      return { ok: true, value: undefined };
    }

    try {
      const row = selectByIdStmt.get(headId);
      if (row === null) {
        return { ok: true, value: undefined };
      }
      return { ok: true, value: rowToNode<T>(row, cid) };
    } catch (e: unknown) {
      return sqlError(e, "head");
    }
  };

  // -----------------------------------------------------------------------
  // list
  // -----------------------------------------------------------------------

  const list = (cid: ChainId): Result<readonly SnapshotNode<T>[], KoiError> => {
    const closedCheck = assertOpen();
    if (closedCheck !== undefined) return closedCheck;

    try {
      const rows = selectByChainStmt.all(cid);
      return { ok: true, value: rows.map((r) => rowToNode<T>(r, cid)) };
    } catch (e: unknown) {
      return sqlError(e, "list");
    }
  };

  // -----------------------------------------------------------------------
  // ancestors
  // -----------------------------------------------------------------------

  const ancestors = (query: AncestorQuery): Result<readonly SnapshotNode<T>[], KoiError> => {
    const closedCheck = assertOpen();
    if (closedCheck !== undefined) return closedCheck;

    try {
      const startRow = selectByIdStmt.get(query.startNodeId);
      if (startRow === null) {
        return {
          ok: false,
          error: notFound(query.startNodeId, `Start node not found: ${query.startNodeId}`),
        };
      }

      // Determine the chain from membership
      const memberRow = selectChainByNodeStmt.get(query.startNodeId);
      const cid = (memberRow?.chain_id ?? "") as ChainId;

      const result: SnapshotNode<T>[] = [];
      const visited = new Set<string>();
      const queue: Array<readonly [SnapshotNode<T>, number]> = [[rowToNode<T>(startRow, cid), 1]];
      let queueIdx = 0; // let justified: index-based BFS avoids O(n) shift

      while (queueIdx < queue.length) {
        const entry = queue[queueIdx];
        queueIdx += 1;
        if (entry === undefined) break;
        const [node, depth] = entry;

        if (visited.has(node.nodeId)) continue;
        visited.add(node.nodeId);
        result.push(node);

        if (query.maxDepth !== undefined && depth >= query.maxDepth) continue;

        for (const pid of node.parentIds) {
          if (!visited.has(pid)) {
            const parentRow = selectByIdStmt.get(pid);
            if (parentRow !== null) {
              // Parent may be in a different chain, use its first membership
              const pMember = selectChainByNodeStmt.get(pid);
              const pCid = (pMember?.chain_id ?? "") as ChainId;
              queue.push([rowToNode<T>(parentRow, pCid), depth + 1]);
            }
          }
        }
      }

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
    const closedCheck = assertOpen();
    if (closedCheck !== undefined) return closedCheck;

    try {
      const sourceRow = selectByIdStmt.get(sourceNodeId);
      if (sourceRow === null) {
        return {
          ok: false,
          error: notFound(sourceNodeId, `Source node not found: ${sourceNodeId}`),
        };
      }

      // Add the source node as a member of the new chain
      const forkSeq = (chainSeqs.get(newChainId) ?? -1) + 1;
      const result = insertMemberStmt.run({
        $chain_id: newChainId,
        $node_id: sourceNodeId,
        $created_at: sourceRow.created_at,
        $seq: forkSeq,
      });
      // INSERT OR IGNORE may silently skip if the row already exists;
      // only update in-memory caches when a row was actually inserted.
      if (result.changes > 0) {
        chainHeads.set(newChainId, sourceNodeId);
        chainSeqs.set(newChainId, forkSeq);
      }

      return { ok: true, value: { parentNodeId: sourceNodeId, label } };
    } catch (e: unknown) {
      return sqlError(e, "fork");
    }
  };

  // -----------------------------------------------------------------------
  // prune
  // -----------------------------------------------------------------------

  const prune = (cid: ChainId, policy: PruningPolicy): Result<number, KoiError> => {
    const closedCheck = assertOpen();
    if (closedCheck !== undefined) return closedCheck;

    try {
      // Get chain members sorted newest first (same order as list)
      const rows = selectByChainStmt.all(cid);
      if (rows.length === 0) {
        return { ok: true, value: 0 };
      }

      const now = Date.now();
      const toRemove = new Set<number>();

      // retainCount: keep the newest N, remove the rest
      if (policy.retainCount !== undefined && rows.length > policy.retainCount) {
        for (let i = policy.retainCount; i < rows.length; i++) {
          toRemove.add(i);
        }
      }

      // retainDuration: remove nodes older than the cutoff
      if (policy.retainDuration !== undefined) {
        const cutoff = now - policy.retainDuration;
        for (let i = 0; i < rows.length; i++) {
          const row = rows[i];
          if (row !== undefined && row.created_at < cutoff) {
            toRemove.add(i);
          }
        }
      }

      // Protect branch heads if retainBranches !== false (default true)
      if (policy.retainBranches !== false) {
        toRemove.delete(0); // Index 0 = newest = chain head
      }

      let removedCount = 0;
      db.transaction(() => {
        for (const idx of toRemove) {
          const row = rows[idx];
          if (row === undefined) continue;
          // Remove membership for this chain
          deleteMemberStmt.run(cid, row.node_id);
          // If no other chain references this node, delete the node itself
          const refCount = countRefsStmt.get(row.node_id);
          if (refCount !== null && refCount.cnt === 0) {
            deleteNodeStmt.run(row.node_id);
          }
          removedCount += 1;
        }
      })();

      // Update head tracking
      if (removedCount === rows.length) {
        chainHeads.delete(cid);
        chainSeqs.delete(cid);
      } else if (removedCount > 0) {
        // Re-derive head from remaining members
        const newHeadRow = selectHeadByChainStmt.get(cid);
        if (newHeadRow !== null) {
          chainHeads.set(cid, newHeadRow.node_id);
          chainSeqs.set(cid, newHeadRow.seq);
        } else {
          chainHeads.delete(cid);
          chainSeqs.delete(cid);
        }
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
