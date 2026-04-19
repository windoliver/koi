/**
 * saveArtifact — full protocol per spec §6.1:
 *   1. Pre-transaction validation
 *   2. Hash bytes (SHA-256 via Bun.CryptoHasher)
 *   3. Journal intent into pending_blob_puts (short tx)
 *   4. blobStore.put(data) — outside the lock
 *   5. BEGIN IMMEDIATE — sequencing, idempotency, tombstone reclaim, INSERT blob_ready=0, retire intent
 *   6. COMMIT
 *   7. Post-commit blob repair: put + has + UPDATE blob_ready=1
 *
 * Plan 2 defers TTL stamping + quota admission + maxVersionsPerName to
 * Plan 3. expires_at is always NULL here.
 */

import type { Database } from "bun:sqlite";
import type { BlobStore } from "@koi/blob-cas";
import { ARTIFACT_COLUMNS, type ArtifactRow, rowToArtifact } from "./row-mapping.js";
import type {
  Artifact,
  ArtifactError,
  ArtifactStoreConfig,
  Result,
  SaveArtifactInput,
} from "./types.js";
import { validateSaveInput } from "./validate.js";

const DEFAULT_MAX_ARTIFACT_BYTES = 100 * 1024 * 1024;

interface TxResult {
  readonly idempotentArtifactId?: string;
  readonly insertedId?: string;
  readonly needsRePut?: boolean;
}

export function createSaveArtifact(args: {
  readonly db: Database;
  readonly blobStore: BlobStore;
  readonly config: ArtifactStoreConfig;
}): (input: SaveArtifactInput) => Promise<Result<Artifact, ArtifactError>> {
  const maxBytes = args.config.maxArtifactBytes ?? DEFAULT_MAX_ARTIFACT_BYTES;

  return async (input) => {
    // Step 1: validate
    const validationError = validateSaveInput(input, maxBytes);
    if (validationError) return { ok: false, error: validationError };

    // Step 2: hash
    const hasher = new Bun.CryptoHasher("sha256");
    hasher.update(input.data);
    const hash = hasher.digest("hex");

    // Step 3: journal intent (short tx, committed immediately)
    const intentId = `intent_${crypto.randomUUID()}`;
    const now = Date.now();
    args.db
      .query("INSERT INTO pending_blob_puts (intent_id, hash, created_at) VALUES (?, ?, ?)")
      .run(intentId, hash, now);

    // Step 4: blob put outside the lock
    await args.blobStore.put(input.data);

    // Step 5: metadata transaction
    const tx = args.db.transaction((): TxResult => {
      // Sequencing: max version across ALL rows (blob_ready 0 or 1)
      const maxRow = args.db
        .query("SELECT MAX(version) AS max FROM artifacts WHERE session_id = ? AND name = ?")
        .get(input.sessionId, input.name) as { readonly max: number | null };
      const nextVersion = (maxRow.max ?? 0) + 1;

      // Idempotency: latest row of any blob_ready state. Only no-op when
      // latest matches AND is currently visible (blob_ready=1, not expired).
      const latest = args.db
        .query(
          "SELECT id, content_hash, blob_ready, expires_at FROM artifacts WHERE session_id = ? AND name = ? ORDER BY version DESC LIMIT 1",
        )
        .get(input.sessionId, input.name) as {
        readonly id: string;
        readonly content_hash: string;
        readonly blob_ready: number;
        readonly expires_at: number | null;
      } | null;

      if (
        latest &&
        latest.content_hash === hash &&
        latest.blob_ready === 1 &&
        (latest.expires_at === null || latest.expires_at >= now)
      ) {
        // Idempotent no-op. Retire intent immediately — no artifact row was
        // inserted for this intent, so the intent serves no recovery purpose.
        args.db.query("DELETE FROM pending_blob_puts WHERE intent_id = ?").run(intentId);
        return { idempotentArtifactId: latest.id };
      }

      // Observe tombstone claim state + reclaim
      const tomb = args.db
        .query("SELECT claimed_at FROM pending_blob_deletes WHERE hash = ?")
        .get(hash) as { readonly claimed_at: number | null } | null;
      const needsRePut = tomb !== null && tomb.claimed_at !== null;
      args.db.query("DELETE FROM pending_blob_deletes WHERE hash = ?").run(hash);

      // Insert artifact row (always blob_ready=0). Do NOT retire the intent
      // yet — we keep it as a durable recovery signal until post-commit repair
      // promotes the row to blob_ready=1. The intent is also updated to point
      // at this specific row's id so recovery can target it directly (not
      // collapse by hash — spec §6.1).
      const newId = `art_${crypto.randomUUID()}`;
      args.db
        .query(
          `INSERT INTO artifacts
             (id, session_id, name, version, mime_type, size, content_hash, tags, created_at, expires_at, blob_ready)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
        )
        .run(
          newId,
          input.sessionId,
          input.name,
          nextVersion,
          input.mimeType,
          input.data.byteLength,
          hash,
          JSON.stringify(input.tags ?? []),
          now,
          null, // Plan 3 stamps expires_at from policy.ttlMs
        );

      // Bind the intent to the specific artifact row so recovery can target it.
      args.db
        .query("UPDATE pending_blob_puts SET artifact_id = ? WHERE intent_id = ?")
        .run(newId, intentId);

      return { insertedId: newId, needsRePut };
    });

    const committed = tx();

    // Idempotent no-op path
    if (committed.idempotentArtifactId) {
      const row = args.db
        .query(`SELECT ${ARTIFACT_COLUMNS} FROM artifacts WHERE id = ?`)
        .get(committed.idempotentArtifactId) as ArtifactRow;
      return { ok: true, value: rowToArtifact(row) };
    }

    const newId = committed.insertedId;
    if (!newId) {
      // Unreachable — tx returns either idempotentArtifactId or insertedId.
      throw new Error("saveArtifact: transaction returned neither path");
    }

    // Step 7: post-commit repair
    if (committed.needsRePut) {
      // Sweep has committed its claim; may delete blob at any moment.
      // Unconditional re-put here, before the verify loop.
      await args.blobStore.put(input.data);
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      if (await args.blobStore.has(hash)) break;
      await args.blobStore.put(input.data);
    }

    const updateResult = args.db
      .query("UPDATE artifacts SET blob_ready = 1 WHERE id = ? AND blob_ready = 0")
      .run(newId);
    if (updateResult.changes === 0) {
      throw new Error(`saveArtifact: row ${newId} was reaped during repair; save is lost`);
    }

    // Row is now durable. Retire the intent.
    args.db.query("DELETE FROM pending_blob_puts WHERE intent_id = ?").run(intentId);

    const row = args.db
      .query(`SELECT ${ARTIFACT_COLUMNS} FROM artifacts WHERE id = ?`)
      .get(newId) as ArtifactRow;
    return { ok: true, value: rowToArtifact(row) };
  };
}
