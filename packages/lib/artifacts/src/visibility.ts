/**
 * isVisible(row, now) — the single predicate used by every read-side API.
 * See spec §6 "Visibility predicate".
 */

export interface VisibilityRow {
  readonly blob_ready: number;
  readonly expires_at: number | null;
}

export function isVisible(row: VisibilityRow, now: number): boolean {
  if (row.blob_ready !== 1) return false;
  if (row.expires_at !== null && row.expires_at < now) return false;
  return true;
}
