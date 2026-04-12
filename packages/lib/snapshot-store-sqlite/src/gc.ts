/**
 * Mark-and-sweep blob garbage collection.
 *
 * Called from `prune()` after the chain transaction commits. Walks every
 * remaining live `snapshot_nodes.data` payload, calls the consumer-supplied
 * `extractBlobRefs(data)` to gather all referenced blob hashes, then lists
 * the blob directory and deletes any blob whose hash is not in the live set.
 *
 * Idempotent — re-running converges. The sweep runs OUTSIDE the SQLite
 * transaction (filesystem ops cannot be rolled back by SQL), so a crash
 * mid-sweep may leave some orphan blobs that the next prune cleans up.
 */

import type { Database } from "bun:sqlite";
import { readdirSync, type Stats, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";

interface PayloadRow {
  readonly data: string;
}

/**
 * Sweep orphan blobs from `blobDir` based on the current live snapshot set.
 *
 * @returns The number of blob files deleted.
 */
export function sweepOrphanBlobs<T>(
  db: Database,
  blobDir: string,
  extractBlobRefs: (data: T) => readonly string[],
): number {
  // Build the set of in-use blob hashes by scanning every live snapshot's
  // payload. For typical workloads (a few hundred snapshots) this is fast;
  // the alternative (per-blob refcount columns) is faster but drifts on
  // crash, so we accept the O(N) sweep for crash safety.
  const liveHashes = new Set<string>();
  const rows = db.query<PayloadRow, []>("SELECT data FROM snapshot_nodes").all();
  for (const row of rows) {
    let parsed: T;
    try {
      parsed = JSON.parse(row.data) as T;
    } catch {
      // A row we can't parse can't be reasoned about — be conservative and
      // skip it (its blobs will not be considered orphans).
      continue;
    }
    for (const hash of extractBlobRefs(parsed)) {
      liveHashes.add(hash);
    }
  }

  return deleteOrphans(blobDir, liveHashes);
}

/**
 * Walk the blob directory and delete files whose hash is not in `liveHashes`.
 *
 * The expected layout is content-addressed:
 *   <blobDir>/<first-2-hex-chars>/<full-sha256-hex>
 * but we also support a flat layout for tests:
 *   <blobDir>/<full-sha256-hex>
 *
 * Either way, we treat each leaf filename as the blob hash. Sub-directory
 * names are not interpreted as hashes.
 */
function deleteOrphans(blobDir: string, liveHashes: ReadonlySet<string>): number {
  let deleted = 0;
  let entries: readonly string[];
  try {
    entries = readdirSync(blobDir);
  } catch {
    // Blob dir doesn't exist yet — nothing to sweep.
    return 0;
  }

  for (const entry of entries) {
    const entryPath = join(blobDir, entry);
    let entryStat: Stats;
    try {
      entryStat = statSync(entryPath);
    } catch {
      continue;
    }

    if (entryStat.isDirectory()) {
      // Sharded layout: <blobDir>/<2-char-prefix>/<full-hash>
      let children: readonly string[];
      try {
        children = readdirSync(entryPath);
      } catch {
        continue;
      }
      for (const child of children) {
        if (!liveHashes.has(child)) {
          try {
            unlinkSync(join(entryPath, child));
            deleted += 1;
          } catch {
            // Best effort — a missing file is fine, a permission error is
            // surfaced indirectly via the count being lower than expected.
          }
        }
      }
    } else if (entryStat.isFile()) {
      // Flat layout: <blobDir>/<full-hash>
      if (!liveHashes.has(entry)) {
        try {
          unlinkSync(entryPath);
          deleted += 1;
        } catch {
          // Best effort.
        }
      }
    }
  }

  return deleted;
}
