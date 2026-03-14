/**
 * SQLite-backed SnapshotChainStore<T> — persistent DAG snapshot storage.
 *
 * Uses bun:sqlite via @koi/sqlite-utils openDb() for WAL mode and optimized
 * PRAGMAs. Supports full DAG topology with separate parent tracking,
 * content-hash deduplication, ancestor walking, forking, and pruning.
 *
 * Chain membership is tracked in `chain_heads` + node `chain_id` columns.
 * A `chain_members` bridge table allows a single node to belong to
 * multiple chains (as required by fork semantics).
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

// ---------------------------------------------------------------------------
// Row types for SELECT queries
// ---------------------------------------------------------------------------

interface NodeRow {
  readonly node_id: string;
  readonly chain_id: string;
  readonly content_hash: string;
  readonly data: string;
  readonly created_at: number;
  readonly metadata: string;
}

interface ParentRow {
  readonly parent_id: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function generateNodeId(): NodeId {
  return `node-${crypto.randomUUID()}` as NodeId;
}

function rowToNode<T>(
  row: NodeRow,
  chainId: ChainId,
  parentIds: readonly NodeId[],
): SnapshotNode<T> {
  return {
    nodeId: row.node_id as NodeId,
    chainId,
    parentIds,
    contentHash: row.content_hash,
    data: JSON.parse(row.data) as T,
    createdAt: row.created_at,
    metadata: JSON.parse(row.metadata) as Readonly<Record<string, unknown>>,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Create a SQLite-backed SnapshotChainStore. */
export function createSqliteSnapshotChainStore<T>(dbPath: string): SnapshotChainStore<T> {
  const db = openDb(dbPath);

  // -- Schema ---------------------------------------------------------------
  db.run(`
    CREATE TABLE IF NOT EXISTS snapshot_nodes (
      node_id TEXT PRIMARY KEY,
      chain_id TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      data TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      metadata TEXT NOT NULL DEFAULT '{}'
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS snapshot_parents (
      node_id TEXT NOT NULL,
      parent_id TEXT NOT NULL,
      PRIMARY KEY (node_id, parent_id),
      FOREIGN KEY (node_id) REFERENCES snapshot_nodes(node_id),
      FOREIGN KEY (parent_id) REFERENCES snapshot_nodes(node_id)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS chain_heads (
      chain_id TEXT PRIMARY KEY,
      node_id TEXT NOT NULL,
      FOREIGN KEY (node_id) REFERENCES snapshot_nodes(node_id)
    )
  `);

  // Bridge table: a node can belong to multiple chains via fork.
  // seq is a per-chain monotonic counter for deterministic ordering within the same ms.
  db.run(`
    CREATE TABLE IF NOT EXISTS chain_members (
      chain_id TEXT NOT NULL,
      node_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      seq INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (chain_id, node_id)
    )
  `);

  db.run("CREATE INDEX IF NOT EXISTS idx_snapshot_nodes_chain ON snapshot_nodes(chain_id)");
  db.run(
    "CREATE INDEX IF NOT EXISTS idx_chain_members_chain ON chain_members(chain_id, created_at DESC, seq DESC)",
  );

  // -- Prepared statements --------------------------------------------------
  const insertNodeStmt = db.prepare(`
    INSERT INTO snapshot_nodes (node_id, chain_id, content_hash, data, created_at, metadata)
    VALUES ($node_id, $chain_id, $content_hash, $data, $created_at, $metadata)
  `);

  const insertParentStmt = db.prepare(`
    INSERT INTO snapshot_parents (node_id, parent_id) VALUES ($node_id, $parent_id)
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

  const selectParentsStmt = db.query<ParentRow, [string]>(
    "SELECT parent_id FROM snapshot_parents WHERE node_id = ?",
  );

  const selectHeadStmt = db.query<{ readonly node_id: string }, [string]>(
    "SELECT node_id FROM chain_heads WHERE chain_id = ?",
  );

  // List: join chain_members with snapshot_nodes, newest first
  const selectChainNodesStmt = db.query<NodeRow, [string]>(
    `SELECT n.* FROM snapshot_nodes n
     INNER JOIN chain_members m ON n.node_id = m.node_id
     WHERE m.chain_id = ?
     ORDER BY m.created_at DESC, m.seq DESC`,
  );

  const deleteMemberStmt = db.prepare(
    "DELETE FROM chain_members WHERE chain_id = ? AND node_id = ?",
  );

  const countMemberRefsStmt = db.query<{ readonly cnt: number }, [string]>(
    "SELECT COUNT(*) as cnt FROM chain_members WHERE node_id = ?",
  );

  const deleteNodeStmt = db.prepare("DELETE FROM snapshot_nodes WHERE node_id = ?");
  const deleteParentsOfStmt = db.prepare("DELETE FROM snapshot_parents WHERE node_id = ?");
  const deleteParentRefsStmt = db.prepare("DELETE FROM snapshot_parents WHERE parent_id = ?");
  const deleteHeadStmt = db.prepare("DELETE FROM chain_heads WHERE chain_id = ?");

  // Per-chain seq counter for deterministic ordering within the same ms
  const chainSeqs = new Map<string, number>();

  // Initialize seq counters from DB
  const initSeqRows = db
    .query<{ readonly chain_id: string; readonly max_seq: number }, []>(
      "SELECT chain_id, MAX(seq) as max_seq FROM chain_members GROUP BY chain_id",
    )
    .all();
  for (const row of initSeqRows) {
    chainSeqs.set(row.chain_id, row.max_seq);
  }

  let closed = false;

  function sqlError(e: unknown, context: string): { readonly ok: false; readonly error: KoiError } {
    return { ok: false, error: mapSqliteError(e, context) };
  }

  function loadParentIds(nid: string): readonly NodeId[] {
    return selectParentsStmt.all(nid).map((r) => r.parent_id as NodeId);
  }

  function nextSeq(cid: string): number {
    const current = chainSeqs.get(cid) ?? -1;
    const next = current + 1;
    chainSeqs.set(cid, next);
    return next;
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
      // Validate parent IDs exist
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

      // Check skipIfUnchanged
      if (options?.skipIfUnchanged === true) {
        const headRow = selectHeadStmt.get(cid);
        if (headRow !== null) {
          const headNode = selectNodeStmt.get(headRow.node_id);
          if (headNode !== null && headNode.content_hash === hash) {
            return { ok: true, value: undefined };
          }
        }
      }

      const nid = generateNodeId();
      const now = Date.now();

      db.transaction(() => {
        insertNodeStmt.run({
          $node_id: nid,
          $chain_id: cid,
          $content_hash: hash,
          $data: JSON.stringify(data),
          $created_at: now,
          $metadata: JSON.stringify(metadata ?? {}),
        });

        for (const pid of parentIds) {
          insertParentStmt.run({ $node_id: nid, $parent_id: pid });
        }

        insertMemberStmt.run({
          $chain_id: cid,
          $node_id: nid,
          $created_at: now,
          $seq: nextSeq(cid),
        });
        upsertHeadStmt.run({ $chain_id: cid, $node_id: nid });
      })();

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
      const row = selectNodeStmt.get(nid);
      if (row === null) {
        return {
          ok: false,
          error: notFound(nid, `Snapshot node not found: ${nid}`),
        };
      }
      const pids = loadParentIds(nid);
      return { ok: true, value: rowToNode<T>(row, row.chain_id as ChainId, pids) };
    } catch (e: unknown) {
      return sqlError(e, "get");
    }
  };

  // -----------------------------------------------------------------------
  // head
  // -----------------------------------------------------------------------

  const head = (cid: ChainId): Result<SnapshotNode<T> | undefined, KoiError> => {
    try {
      const headRow = selectHeadStmt.get(cid);
      if (headRow === null) {
        return { ok: true, value: undefined };
      }
      const row = selectNodeStmt.get(headRow.node_id);
      if (row === null) {
        return { ok: true, value: undefined };
      }
      const pids = loadParentIds(headRow.node_id);
      return { ok: true, value: rowToNode<T>(row, cid, pids) };
    } catch (e: unknown) {
      return sqlError(e, "head");
    }
  };

  // -----------------------------------------------------------------------
  // list
  // -----------------------------------------------------------------------

  const list = (cid: ChainId): Result<readonly SnapshotNode<T>[], KoiError> => {
    try {
      const rows = selectChainNodesStmt.all(cid);
      const nodes = rows.map((r) => {
        const pids = loadParentIds(r.node_id);
        return rowToNode<T>(r, cid, pids);
      });
      return { ok: true, value: nodes };
    } catch (e: unknown) {
      return sqlError(e, "list");
    }
  };

  // -----------------------------------------------------------------------
  // ancestors
  // -----------------------------------------------------------------------

  const ancestors = (query: AncestorQuery): Result<readonly SnapshotNode<T>[], KoiError> => {
    try {
      const startRow = selectNodeStmt.get(query.startNodeId);
      if (startRow === null) {
        return {
          ok: false,
          error: notFound(query.startNodeId, `Start node not found: ${query.startNodeId}`),
        };
      }

      const result: SnapshotNode<T>[] = [];
      const visited = new Set<string>();
      const startPids = loadParentIds(query.startNodeId);
      // Queue: [node, depth] — BFS walk
      const queue: Array<readonly [SnapshotNode<T>, number]> = [
        [rowToNode<T>(startRow, startRow.chain_id as ChainId, startPids), 1],
      ];
      // let justified: index-based BFS avoids O(n) shift
      let queueIdx = 0;

      while (queueIdx < queue.length) {
        const entry = queue[queueIdx];
        queueIdx += 1;
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
            const parentRow = selectNodeStmt.get(pid);
            if (parentRow !== null) {
              const parentPids = loadParentIds(pid);
              queue.push([
                rowToNode<T>(parentRow, parentRow.chain_id as ChainId, parentPids),
                depth + 1,
              ]);
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
    try {
      const sourceRow = selectNodeStmt.get(sourceNodeId);
      if (sourceRow === null) {
        return {
          ok: false,
          error: notFound(sourceNodeId, `Source node not found: ${sourceNodeId}`),
        };
      }

      db.transaction(() => {
        // Add the source node as a member of the new chain
        insertMemberStmt.run({
          $chain_id: newChainId,
          $node_id: sourceNodeId,
          $created_at: sourceRow.created_at,
          $seq: nextSeq(newChainId),
        });
        // Set the source node as the head of the new chain
        upsertHeadStmt.run({ $chain_id: newChainId, $node_id: sourceNodeId });
      })();

      return { ok: true, value: { parentNodeId: sourceNodeId, label } };
    } catch (e: unknown) {
      return sqlError(e, "fork");
    }
  };

  // -----------------------------------------------------------------------
  // prune
  // -----------------------------------------------------------------------

  const prune = (cid: ChainId, policy: PruningPolicy): Result<number, KoiError> => {
    try {
      // Get chain nodes sorted newest first (same order as list)
      const rows = selectChainNodesStmt.all(cid);
      if (rows.length === 0) {
        return { ok: true, value: 0 };
      }

      const now = Date.now();
      const toRemove = new Set<number>();

      // retainCount: keep the newest N (from the front), remove the rest
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
          const nid = row.node_id;

          // Remove this node from the chain's membership
          deleteMemberStmt.run(cid, nid);

          // If no other chain references this node, delete the node itself
          const refRow = countMemberRefsStmt.get(nid);
          const totalRefs = refRow?.cnt ?? 0;

          if (totalRefs === 0) {
            deleteParentsOfStmt.run(nid);
            deleteParentRefsStmt.run(nid);
            deleteNodeStmt.run(nid);
          }

          removedCount += 1;
        }

        // Update head: if all nodes removed, delete head entirely.
        // If the head was pruned but other nodes remain, point to the newest surviving member.
        if (removedCount === rows.length) {
          deleteHeadStmt.run(cid);
        } else if (toRemove.has(0)) {
          // Head (index 0 = newest) was pruned — find the first surviving node
          const newHeadRow = db
            .query<{ readonly node_id: string }, [string]>(
              `SELECT node_id FROM chain_members
               WHERE chain_id = ?
               ORDER BY created_at DESC, seq DESC
               LIMIT 1`,
            )
            .get(cid);
          if (newHeadRow !== null) {
            upsertHeadStmt.run({ $chain_id: cid, $node_id: newHeadRow.node_id });
          } else {
            deleteHeadStmt.run(cid);
          }
        }
      })();

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
