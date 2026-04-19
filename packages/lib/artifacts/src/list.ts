/**
 * listArtifacts — returns all visible artifacts the caller can see.
 *
 * Scope: owned by `ctx.sessionId`, plus (if `filter.includeShared`) any
 * artifacts shared to it. Visibility predicate is applied (blob_ready=1 AND
 * not TTL-expired). Name + tags filters are applied in SQL where cheap, in JS
 * where more ergonomic (tags, since they're stored as JSON).
 */

import type { Database } from "bun:sqlite";
import type { SessionId } from "@koi/core";
import { ARTIFACT_COLUMNS, type ArtifactRow, rowToArtifact } from "./row-mapping.js";
import type { Artifact, ArtifactFilter } from "./types.js";

export function createListArtifacts(args: {
  readonly db: Database;
}): (
  filter: ArtifactFilter,
  ctx: { readonly sessionId: SessionId },
) => Promise<ReadonlyArray<Artifact>> {
  return async (filter, ctx) => {
    const now = Date.now();
    const includeShared = filter.includeShared === true;

    const whereAuth = includeShared
      ? `(session_id = ? OR EXISTS (SELECT 1 FROM artifact_shares
                                     WHERE artifact_id = artifacts.id
                                       AND granted_to_session_id = ?))`
      : `session_id = ?`;
    const params: Array<string | number> = includeShared
      ? [ctx.sessionId, ctx.sessionId]
      : [ctx.sessionId];

    params.push(now);

    let nameClause = "";
    if (filter.name !== undefined) {
      nameClause = "AND name = ?";
      params.push(filter.name);
    }

    const sql = `
      SELECT ${ARTIFACT_COLUMNS} FROM artifacts
       WHERE ${whereAuth}
         AND blob_ready = 1
         AND (expires_at IS NULL OR expires_at >= ?)
         ${nameClause}
       ORDER BY session_id, name, version DESC
    `;

    const rows = args.db.query(sql).all(...params) as ArtifactRow[];
    const artifacts = rows.map(rowToArtifact);

    // Tags filter: AND semantics in JS since tags is stored as JSON.
    if (filter.tags && filter.tags.length > 0) {
      const required = new Set(filter.tags);
      return artifacts.filter((a) => {
        for (const t of required) {
          if (!a.tags.includes(t)) return false;
        }
        return true;
      });
    }

    return artifacts;
  };
}
