/**
 * Per-session byte quota accounting.
 *
 * `readSessionBytes` sums `artifacts.size` across all committed (blob_ready=1)
 * rows for a session. Called from `saveArtifact` BEFORE journaling intent
 * (§6.1 step 3) so that over-quota saves produce no side effects: no pending
 * intent, no blob I/O, no row.
 *
 * `blob_ready=0` rows are deliberately excluded. Those are in-flight saves
 * whose post-commit repair has not yet promoted the row; counting them would
 * reject legitimate saves below the real limit during transient repair
 * windows. If the in-flight save eventually succeeds, its bytes are
 * accounted for on the next quota check. If it fails and is reaped by
 * startup recovery, it never consumed the limit.
 */

import type { Database } from "bun:sqlite";
import type { SessionId } from "@koi/core";

function isSumRow(v: unknown): v is { readonly total: number | null } {
  return (
    typeof v === "object" &&
    v !== null &&
    "total" in v &&
    (typeof (v as { readonly total: unknown }).total === "number" ||
      (v as { readonly total: unknown }).total === null)
  );
}

export function readSessionBytes(db: Database, session: SessionId): number {
  const row = db
    .query(
      "SELECT COALESCE(SUM(size), 0) AS total FROM artifacts WHERE session_id = ? AND blob_ready = 1",
    )
    .get(session);
  if (!isSumRow(row)) {
    throw new Error(
      `readSessionBytes: unexpected row shape from SUM query for session ${String(session)}`,
    );
  }
  return row.total ?? 0;
}
