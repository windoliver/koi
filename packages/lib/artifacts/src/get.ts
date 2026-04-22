/**
 * getArtifact — visibility-predicate filtering + post-read ACL recheck.
 * See spec §6.2. Step 4 recheck closes the get-vs-revoke and get-vs-sweep
 * races by re-evaluating both visibility and authorization after the blob
 * read completes.
 */

import type { Database } from "bun:sqlite";
import type { BlobStore } from "@koi/blob-cas";
import type { ArtifactId, SessionId } from "@koi/core";
import { ARTIFACT_COLUMNS, type ArtifactRow, rowToArtifact } from "./row-mapping.js";
import type { Artifact, ArtifactError, Result } from "./types.js";

type GetArtifactResult = Result<
  { readonly meta: Artifact; readonly data: Uint8Array },
  ArtifactError
>;

interface GetRow extends ArtifactRow {
  readonly blob_ready: number;
}

export function createGetArtifact(args: {
  readonly db: Database;
  readonly blobStore: BlobStore;
}): (id: ArtifactId, ctx: { readonly sessionId: SessionId }) => Promise<GetArtifactResult> {
  return async (id, ctx) => {
    const now = Date.now();

    // Step 1: fetch row (visibility check applied below)
    const row = args.db
      .query(`SELECT ${ARTIFACT_COLUMNS}, blob_ready FROM artifacts WHERE id = ?`)
      .get(id) as GetRow | null;

    if (!row) return { ok: false, error: { kind: "not_found", id } };
    if (row.blob_ready !== 1) return { ok: false, error: { kind: "not_found", id } };
    if (row.expires_at !== null && row.expires_at < now) {
      return { ok: false, error: { kind: "not_found", id } };
    }

    // Step 2: ACL check
    if (row.session_id !== ctx.sessionId) {
      const share = args.db
        .query("SELECT 1 FROM artifact_shares WHERE artifact_id = ? AND granted_to_session_id = ?")
        .get(id, ctx.sessionId);
      if (!share) return { ok: false, error: { kind: "not_found", id } };
    }

    // Step 3: blob read
    const data = await args.blobStore.get(row.content_hash);

    // Step 4: post-read revalidation (visibility + ACL with fresh now)
    const nowAfter = Date.now();
    const revalidation = args.db
      .query(
        `SELECT 1 FROM artifacts WHERE id = ?
           AND blob_ready = 1
           AND (expires_at IS NULL OR expires_at >= ?)
           AND (
             session_id = ?
             OR EXISTS (SELECT 1 FROM artifact_shares
                          WHERE artifact_id = ? AND granted_to_session_id = ?)
           )`,
      )
      .get(id, nowAfter, ctx.sessionId, id, ctx.sessionId);

    if (!revalidation) return { ok: false, error: { kind: "not_found", id } };

    if (data === undefined) {
      // Row is still visible + authorized but blob is missing → corruption.
      throw new Error(`getArtifact: blob missing for live artifact ${id}; contact operator`);
    }

    return {
      ok: true,
      value: {
        meta: rowToArtifact(row),
        data,
      },
    };
  };
}
