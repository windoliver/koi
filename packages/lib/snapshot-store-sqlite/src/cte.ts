/**
 * Recursive CTE for ancestor walks.
 *
 * Replaces the v1 BFS-with-N+1-queries pattern with a single recursive SQL
 * query that walks parent hashes via `json_each` over the `parent_ids` JSON
 * column.
 *
 * `UNION` (not `UNION ALL`) deduplicates DAG diamonds where a node has
 * multiple paths to the same ancestor. The depth column is propagated so we
 * can return ancestors in BFS order (start node first, then by distance).
 */

import type { Database } from "bun:sqlite";

export interface AncestorRow {
  readonly node_id: string;
  readonly chain_id: string;
  readonly parent_ids: string;
  readonly content_hash: string;
  readonly data: string;
  readonly created_at: number;
  readonly metadata: string;
  readonly depth: number;
}

/**
 * Walk ancestors from `startNodeId` up to `maxDepth` (inclusive). Depth 0 is
 * the start node itself; depth 1 is its parents; etc.
 *
 * If `maxDepth` is undefined, walks to the root. We pass a sentinel value
 * (`Number.MAX_SAFE_INTEGER`) to keep the SQL query a single static string
 * — using a parameter sidesteps the SQLite recursion-depth quirk while
 * keeping the prepared statement cacheable.
 */
export function walkAncestors(
  db: Database,
  startNodeId: string,
  maxDepth: number | undefined,
): readonly AncestorRow[] {
  // The CTE walks from startNodeId outward through json_each(parent_ids).
  // depth=0 is the start; depth=1 is its parents; etc. We bound depth via
  // a SQL parameter so the query plan stays cached.
  //
  // UNION (not UNION ALL) collapses DAG diamonds — same node reached via
  // two paths at different depths is visited once at the smaller depth.
  const stmt = db.query<AncestorRow, [string, number]>(`
    WITH RECURSIVE ancestors(node_id, depth) AS (
        SELECT ?, 0
      UNION
        SELECT json_each.value, ancestors.depth + 1
        FROM ancestors
        JOIN snapshot_nodes ON snapshot_nodes.node_id = ancestors.node_id
        JOIN json_each(snapshot_nodes.parent_ids)
        WHERE ancestors.depth < ?
    )
    SELECT n.*, a.depth FROM snapshot_nodes n
    JOIN ancestors a ON n.node_id = a.node_id
    ORDER BY a.depth ASC, n.created_at DESC
  `);
  const cap = maxDepth ?? Number.MAX_SAFE_INTEGER;
  return stmt.all(startNodeId, cap);
}
