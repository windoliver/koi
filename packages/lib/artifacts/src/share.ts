/**
 * shareArtifact / revokeShare — owner-only.
 * share applies the full isVisible predicate (can't share an expired row).
 * revoke is owner-override (blob_ready=1 only, no TTL check) so owners can
 * revoke grants on expired rows before sweep (spec §6.2 owner overrides).
 */

import type { Database } from "bun:sqlite";
import type { ArtifactId, SessionId } from "@koi/core";
import type { ArtifactError, Result } from "./types.js";

export function createShareArtifact(args: {
  readonly db: Database;
}): (
  id: ArtifactId,
  withSessionId: SessionId,
  ctx: { readonly ownerSessionId: SessionId },
) => Promise<Result<void, ArtifactError>> {
  return async (id, withSessionId, ctx) => {
    const now = Date.now();
    // Owner check + full visibility (not expired)
    const row = args.db
      .query(
        `SELECT 1 FROM artifacts WHERE id = ?
           AND session_id = ?
           AND blob_ready = 1
           AND (expires_at IS NULL OR expires_at >= ?)`,
      )
      .get(id, ctx.ownerSessionId, now);

    if (!row) return { ok: false, error: { kind: "not_found", id } };

    args.db
      .query(
        `INSERT INTO artifact_shares (artifact_id, granted_to_session_id, granted_at)
         VALUES (?, ?, ?) ON CONFLICT DO NOTHING`,
      )
      .run(id, withSessionId, now);

    return { ok: true, value: undefined };
  };
}

export function createRevokeShare(args: {
  readonly db: Database;
}): (
  id: ArtifactId,
  fromSessionId: SessionId,
  ctx: { readonly ownerSessionId: SessionId },
) => Promise<Result<void, ArtifactError>> {
  return async (id, fromSessionId, ctx) => {
    // Owner-override: blob_ready=1 only, no TTL check.
    const row = args.db
      .query("SELECT 1 FROM artifacts WHERE id = ? AND session_id = ? AND blob_ready = 1")
      .get(id, ctx.ownerSessionId);

    if (!row) return { ok: false, error: { kind: "not_found", id } };

    args.db
      .query("DELETE FROM artifact_shares WHERE artifact_id = ? AND granted_to_session_id = ?")
      .run(id, fromSessionId);

    return { ok: true, value: undefined };
  };
}
