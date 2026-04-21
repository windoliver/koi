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
 * Plan 3 stamps `expires_at` at save time via `computeExpiresAt(now, policy)`
 * — the value is frozen on the row and never recomputed from live policy on
 * subsequent reads (freeze-at-save semantics, spec §4 / §6.1). When no policy
 * or no `ttlMs` is configured, `expires_at` is persisted as NULL.
 */

import type { Database } from "bun:sqlite";
import type { BlobStore } from "@koi/blob-cas";
import { computeExpiresAt } from "./policy.js";
import { readSessionBytes } from "./quota.js";
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
  readonly resumeArtifactId?: string;
  readonly resumeIntentId?: string;
  readonly needsRePut?: boolean;
}

export function createSaveArtifact(args: {
  readonly db: Database;
  readonly blobStore: BlobStore;
  readonly config: ArtifactStoreConfig;
}): (input: SaveArtifactInput) => Promise<Result<Artifact, ArtifactError>> {
  const maxBytes = args.config.maxArtifactBytes ?? DEFAULT_MAX_ARTIFACT_BYTES;
  const policy = args.config.policy;
  const maxSessionBytes = policy?.maxSessionBytes;

  return async (input) => {
    // Step 1: validate
    const validationError = validateSaveInput(input, maxBytes);
    if (validationError) return { ok: false, error: validationError };

    // Step 2: hash
    const hasher = new Bun.CryptoHasher("sha256");
    hasher.update(input.data);
    const hash = hasher.digest("hex");

    // Quota admission — runs BEFORE intent journaling so over-quota saves
    // produce zero side effects (no pending_blob_puts row, no blob I/O).
    // Only committed (blob_ready=1) rows count toward the total; in-flight
    // saves are excluded to avoid rejecting legitimate saves below the real
    // limit during repair windows. See quota.ts for the rationale.
    if (maxSessionBytes !== undefined) {
      const usedBytes = readSessionBytes(args.db, input.sessionId);
      if (usedBytes + input.data.byteLength > maxSessionBytes) {
        return {
          ok: false,
          error: {
            kind: "quota_exceeded",
            sessionId: input.sessionId,
            usedBytes,
            limitBytes: maxSessionBytes,
          },
        };
      }
    }

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

      // Resume-in-flight: if the latest row has matching hash but blob_ready=0
      // AND there's an existing intent bound to it, the caller is retrying a
      // save whose previous post-commit repair failed. Complete the existing
      // row's repair rather than creating a new version.
      if (latest && latest.content_hash === hash && latest.blob_ready === 0) {
        const existingIntent = args.db
          .query("SELECT intent_id FROM pending_blob_puts WHERE artifact_id = ? AND hash = ?")
          .get(latest.id, hash) as { readonly intent_id: string } | null;
        if (existingIntent) {
          // Retire the intent we just journaled — we're going to reuse the
          // existing intent (and row) instead.
          args.db.query("DELETE FROM pending_blob_puts WHERE intent_id = ?").run(intentId);
          return {
            resumeArtifactId: latest.id,
            resumeIntentId: existingIntent.intent_id,
          };
        }
      }

      // Observe tombstone claim state + conditionally reclaim.
      //
      // Three branches per spec §6.1 step 5 + §6.3 race analysis:
      //   (a) no tombstone → normal path, no interaction.
      //   (b) tombstone with claimed_at IS NULL → Phase B has not claimed;
      //       reclaim by DELETE gated on `claimed_at IS NULL` (guards against
      //       a concurrent claim tx between our SELECT and DELETE). If the
      //       gated DELETE hits 0 rows, Phase B claimed during the window —
      //       fall through to the claimed branch and re-put post-commit.
      //   (c) tombstone with claimed_at IS NOT NULL → Phase B owns this
      //       tombstone. Leave it alone (Phase B's reconcile will remove
      //       it) and set needsRePut = true so we unconditionally re-put
      //       after commit — Phase B's blob delete may run any time.
      const tomb = args.db
        .query("SELECT claimed_at FROM pending_blob_deletes WHERE hash = ?")
        .get(hash) as { readonly claimed_at: number | null } | null;
      let needsRePut = false;
      if (tomb !== null) {
        if (tomb.claimed_at === null) {
          const del = args.db
            .query("DELETE FROM pending_blob_deletes WHERE hash = ? AND claimed_at IS NULL")
            .run(hash);
          if (del.changes === 0) {
            // Phase B claimed between our SELECT and our DELETE. Leave the
            // tombstone (Phase B owns it) and re-put post-commit.
            needsRePut = true;
          }
        } else {
          // Phase B already owns the tombstone. Don't touch it.
          needsRePut = true;
        }
      }

      // Insert artifact row (always blob_ready=0). Do NOT retire the intent
      // yet — we keep it as a durable recovery signal until post-commit repair
      // promotes the row to blob_ready=1. The intent is also updated to point
      // at this specific row's id so recovery can target it directly (not
      // collapse by hash — spec §6.1).
      //
      // expires_at is frozen at save time from the live policy. Later policy
      // changes never recompute or resurrect this value (spec §4 / §6.1).
      const newId = `art_${crypto.randomUUID()}`;
      const expiresAt = computeExpiresAt(now, policy);
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
          expiresAt,
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

    // Resume-in-flight path: finish the existing row's repair instead of
    // creating a duplicate. Falls through to the same post-commit repair loop.
    if (committed.resumeArtifactId && committed.resumeIntentId) {
      const verified = await verifyBlobPresent(args.blobStore, hash, input.data);
      if (!verified) {
        throw new Error(
          `saveArtifact: blob presence could not be verified after repair (hash=${hash}); row left at blob_ready=0, intent retained for recovery`,
        );
      }
      const updateResult = args.db
        .query("UPDATE artifacts SET blob_ready = 1 WHERE id = ? AND blob_ready = 0")
        .run(committed.resumeArtifactId);
      if (updateResult.changes === 0) {
        // Row was reaped between the tx and the UPDATE — treat as lost and
        // surface as a caller-retriable error.
        throw new Error(
          `saveArtifact: resume target ${committed.resumeArtifactId} was reaped; retry`,
        );
      }
      args.db
        .query("DELETE FROM pending_blob_puts WHERE intent_id = ?")
        .run(committed.resumeIntentId);
      const row = args.db
        .query(`SELECT ${ARTIFACT_COLUMNS} FROM artifacts WHERE id = ?`)
        .get(committed.resumeArtifactId) as ArtifactRow;
      return { ok: true, value: rowToArtifact(row) };
    }

    const newId = committed.insertedId;
    if (!newId) {
      // Unreachable — tx returns idempotent | resume | insertedId.
      throw new Error("saveArtifact: transaction returned no path");
    }

    // Step 7: post-commit repair. Verify blob presence positively before
    // flipping blob_ready=1 — a row published without verified bytes would
    // surface a corruption error on the next get, not a successful save.
    if (committed.needsRePut) {
      // Sweep has committed its claim; may delete blob at any moment.
      // Unconditional re-put here, before the verify loop.
      await args.blobStore.put(input.data);
    }
    const verified = await verifyBlobPresent(args.blobStore, hash, input.data);
    if (!verified) {
      // Fail closed: leave row at blob_ready=0 + intent in place so startup
      // recovery can either promote it (if the backend comes back) or reap it.
      throw new Error(
        `saveArtifact: blob presence could not be verified after repair (hash=${hash}); row ${newId} left at blob_ready=0 for recovery`,
      );
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

/**
 * Attempts up to 2 put/has cycles, then does one final has() to confirm.
 * Returns true iff has() returned true at any point; false means the backend
 * never confirmed presence and the caller should NOT publish blob_ready=1.
 */
async function verifyBlobPresent(
  blobStore: BlobStore,
  hash: string,
  data: Uint8Array,
): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt++) {
    if (await blobStore.has(hash)) return true;
    await blobStore.put(data);
  }
  return await blobStore.has(hash);
}
