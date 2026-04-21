/**
 * deleteArtifact — owner-only; blob_ready=1 filter (owner override on
 * TTL-expired per spec §6.2). Metadata delete + tombstone insert atomic
 * in one BEGIN IMMEDIATE. Blob unlink deferred to Plan 3's sweepArtifacts.
 */

import type { Database } from "bun:sqlite";
import type { ArtifactId, SessionId } from "@koi/core";
import type { ArtifactError, Result } from "./types.js";

export function createDeleteArtifact(args: {
  readonly db: Database;
}): (
  id: ArtifactId,
  ctx: { readonly sessionId: SessionId },
) => Promise<Result<void, ArtifactError>> {
  return async (id, ctx) => {
    const tx = args.db.transaction((): Result<void, ArtifactError> => {
      // Owner-only, blob_ready=1 only (owner can delete expired rows per §6.2).
      const row = args.db
        .query(
          "SELECT content_hash FROM artifacts WHERE id = ? AND session_id = ? AND blob_ready = 1",
        )
        .get(id, ctx.sessionId) as { readonly content_hash: string } | null;

      if (!row) return { ok: false, error: { kind: "not_found", id } };

      args.db.query("DELETE FROM artifacts WHERE id = ?").run(id);

      // Check if any other row (any blob_ready state) or pending_blob_puts
      // intent still references this hash.
      const stillReferenced = args.db
        .query(
          `SELECT 1 WHERE EXISTS (SELECT 1 FROM artifacts WHERE content_hash = ?)
                        OR EXISTS (SELECT 1 FROM pending_blob_puts WHERE hash = ?)`,
        )
        .get(row.content_hash, row.content_hash);

      if (!stillReferenced) {
        args.db
          .query(
            "INSERT INTO pending_blob_deletes (hash, enqueued_at) VALUES (?, ?) ON CONFLICT DO NOTHING",
          )
          .run(row.content_hash, Date.now());
      }

      return { ok: true, value: undefined };
    });

    return tx();
  };
}
