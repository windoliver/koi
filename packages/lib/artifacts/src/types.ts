/**
 * Public types for @koi/artifacts.
 *
 * The ArtifactStore interface is the main surface. ArtifactError is a
 * discriminated union for expected failures (per CLAUDE.md error policy:
 * return Result<T, E> rather than throw for expected cases).
 *
 * Note: there is no public `forbidden` error kind. Non-owner access to an
 * artifact always surfaces as `not_found` on the wire (probe-resistance).
 * Forbidden is a distinct *internal* concept used for structured logging
 * only — never returned.
 */

import type { BlobStore } from "@koi/blob-cas";
import type { ArtifactId, SessionId } from "@koi/core";

export interface Artifact {
  readonly id: ArtifactId;
  readonly sessionId: SessionId;
  readonly name: string;
  readonly version: number;
  readonly mimeType: string;
  readonly size: number;
  readonly contentHash: string;
  readonly createdAt: number;
  readonly expiresAt: number | null;
  readonly tags: ReadonlyArray<string>;
}

export interface SaveArtifactInput {
  readonly sessionId: SessionId;
  readonly name: string;
  readonly data: Uint8Array;
  readonly mimeType: string;
  readonly tags?: ReadonlyArray<string>;
}

export interface ArtifactFilter {
  readonly name?: string;
  readonly tags?: ReadonlyArray<string>;
  readonly includeShared?: boolean;
}

export interface LifecyclePolicy {
  readonly ttlMs?: number;
  readonly maxSessionBytes?: number;
  readonly maxVersionsPerName?: number;
}

export type ArtifactError =
  | { readonly kind: "not_found"; readonly id: ArtifactId }
  | {
      readonly kind: "quota_exceeded";
      readonly sessionId: SessionId;
      readonly usedBytes: number;
      readonly limitBytes: number;
    }
  | {
      readonly kind: "invalid_input";
      readonly field: string;
      readonly reason: string;
    };

export type Result<T, E> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

/**
 * Phase A sweep result (spec §6.3). `deleted` is the number of metadata rows
 * reaped; `bytesReclaimed` is the sum of those rows' `size` columns. Phase B
 * (blob-on-disk reclamation) runs separately via the tombstone journal and
 * is not reflected here.
 */
export interface SweepArtifactsResult {
  readonly deleted: number;
  readonly bytesReclaimed: number;
}

/**
 * `scavengeOrphanBlobs()` result (spec §6.4). Disaster-recovery only —
 * walks the backing store, journals tombstones for every hash with no live
 * reference, then drives Phase B. `deleted` is the number of blobs actually
 * reaped via Phase B's reconcile step. `bytesReclaimed` is 0 in Plan 3
 * (list() yields hashes only; we deliberately don't re-read bytes just to
 * measure size). See scavenger.ts for rationale.
 */
export interface ScavengeOrphanBlobsResult {
  readonly deleted: number;
  readonly bytesReclaimed: number;
}

export interface ArtifactStore {
  readonly saveArtifact: (input: SaveArtifactInput) => Promise<Result<Artifact, ArtifactError>>;
  readonly getArtifact: (
    id: ArtifactId,
    ctx: { readonly sessionId: SessionId },
  ) => Promise<Result<{ readonly meta: Artifact; readonly data: Uint8Array }, ArtifactError>>;
  readonly listArtifacts: (
    filter: ArtifactFilter,
    ctx: { readonly sessionId: SessionId },
  ) => Promise<ReadonlyArray<Artifact>>;
  readonly deleteArtifact: (
    id: ArtifactId,
    ctx: { readonly sessionId: SessionId },
  ) => Promise<Result<void, ArtifactError>>;
  readonly shareArtifact: (
    id: ArtifactId,
    withSessionId: SessionId,
    ctx: { readonly ownerSessionId: SessionId },
  ) => Promise<Result<void, ArtifactError>>;
  readonly revokeShare: (
    id: ArtifactId,
    fromSessionId: SessionId,
    ctx: { readonly ownerSessionId: SessionId },
  ) => Promise<Result<void, ArtifactError>>;
  /**
   * Apply the store's configured lifecycle policy (TTL / quota / retention)
   * to reap eligible rows. Plan 3 Phase A only — returns the metadata-level
   * deletion tally. Phase B drains tombstones separately (Task 6).
   */
  readonly sweepArtifacts: () => Promise<SweepArtifactsResult>;
  /**
   * Disaster-recovery scavenger (spec §6.4). Walks the backing store,
   * journals tombstones for every blob with no live reference, then drives
   * Phase B. NEVER deletes blobs directly. O(N) over the blob store —
   * operator-run, not hot-path. Safe to invoke while saves/sweeps run
   * concurrently; Phase B's claim predicate protects in-flight bytes.
   */
  readonly scavengeOrphanBlobs: () => Promise<ScavengeOrphanBlobsResult>;
  readonly close: () => Promise<void>;
}

export interface ArtifactStoreConfig {
  readonly dbPath: string;
  /**
   * Root directory for the default filesystem `BlobStore`. Required when
   * `blobStore` is omitted. Ignored when `blobStore` is provided (the
   * pluggable backend owns its own root).
   */
  readonly blobDir?: string;
  /**
   * Optional `BlobStore` override (Plan 5 — #1922). When provided, the store
   * uses this backend verbatim and skips all FS-specific bootstrap
   * (`mkdirSync(blobDir)`, `createFilesystemBlobStore`). The backend-agnostic
   * store-id sentinel (§3.0) pairs the metadata DB against
   * `blobStore.sentinel` rather than a filesystem path. Built-in factories
   * (`createFilesystemBlobStore`, `createS3BlobStore`) populate `sentinel`
   * automatically; third-party backends that omit it cannot be used here.
   */
  readonly blobStore?: BlobStore;
  readonly durability?: "process" | "os";
  readonly maxArtifactBytes?: number;
  /**
   * Terminal-delete threshold for confirmed-missing blobs during startup
   * recovery. Default 10. Lower values terminal-delete faster (tests use
   * 2); higher values tolerate longer backend outages across restarts.
   */
  readonly maxRepairAttempts?: number;
  /**
   * Grace window (ms) after which a `pending_blob_puts` row is considered
   * stale and eligible for the startup recovery drain (spec §6.5 step 1).
   * Default 300_000 (5 minutes).
   *
   * This is a **safety bound**: it must exceed worst-case save latency so a
   * real in-flight save is never mistaken for stale by a concurrent startup
   * recovery pass. Values below typical blob-backend latency risk a
   * recovery pass converting a live save's intent into a tombstone that
   * then races the save's own post-commit blob write.
   *
   * Must be a finite integer >= 0. Production configurations must be
   * >= 60_000 (1 minute); smaller values are rejected at construction unless
   * the caller also sets `__TEST_ONLY_unsafeStaleIntentGrace: true`. The
   * floor protects committed saves from being misclassified as stale and
   * converted to tombstones on restart.
   */
  readonly staleIntentGraceMs?: number;
  /**
   * Test-only escape hatch for `staleIntentGraceMs`. Set to `true` to permit
   * a `staleIntentGraceMs` below the 60_000 production floor. Never set in
   * production — a short grace window can convert an in-flight save's intent
   * into a tombstone, permanently destroying committed data. The name is
   * deliberately verbose so grep/code review catches misuse.
   */
  readonly __TEST_ONLY_unsafeStaleIntentGrace?: boolean;
  /**
   * Lifecycle policy: TTL, quota, and per-name retention. Fields are all
   * optional; when present each must be a finite positive integer. Validated
   * at construction (Plan 3 — #1920). `ttlMs` is frozen onto each row's
   * `expires_at` at save time; later policy changes never recompute it.
   */
  readonly policy?: LifecyclePolicy;
  /**
   * Background repair worker cadence (Plan 4 — spec §6.5 step 4). Controls
   * the interval between worker iterations that drain `blob_ready = 0` rows
   * and `pending_blob_deletes` tombstones.
   *
   * - Integer >= 100 (ms) — a `setInterval` is scheduled at that cadence.
   * - `"manual"` — disables the interval entirely; only the `runOnce` path
   *   (used by the close-barrier flush and by tests) triggers work.
   *
   * Default: 30_000 ms. The 100ms floor guards against pathological busy
   * loops — a tighter cadence is almost always a misconfiguration and would
   * starve save/get transactions with BEGIN IMMEDIATE contention. Fractional
   * or non-finite values are rejected at construction (parity with
   * `maxRepairAttempts` / `staleIntentGraceMs`).
   */
  readonly workerIntervalMs?: number | "manual";
  /**
   * Structured drift signal (Plan 4 — spec §6.5 step 4c). Fires for repair
   * events that operators should observe:
   *
   *   - `repair_exhausted` — a `blob_ready = 0` row was terminal-deleted
   *     because its absence probe hit `maxRepairAttempts`. A steady stream
   *     of these implies a systemic blob-write loss, not a transient outage.
   *
   *   - `transient_repair_error` — `blobStore.has()` threw during a repair
   *     probe. The raw error is surfaced so operators can triage
   *     backend-specific failure modes (5xx rate, DNS, quota).
   *
   * Default: no-op (no logging noise). The callback is synchronous; users
   * that want async sinks must queue internally. A callback that throws is
   * swallowed and logged once via console.warn — a bad observer cannot
   * corrupt repair progress.
   *
   * Below-budget `repair_attempts` increments do NOT emit — those are
   * expected and operationally silent.
   */
  readonly onEvent?: (event: ArtifactStoreEvent) => void;
}

/**
 * Structured drift signal surfaced by the background repair worker
 * (Plan 4 — spec §6.5 step 4c). Kinds and fields are a stable public API
 * — consumers pattern-match on `kind`.
 */
export type ArtifactStoreEvent =
  | {
      readonly kind: "repair_exhausted";
      readonly artifactId: ArtifactId;
      readonly contentHash: string;
      readonly sessionId: SessionId;
      readonly attempts: number;
    }
  | {
      readonly kind: "transient_repair_error";
      readonly artifactId: ArtifactId;
      readonly contentHash: string;
      readonly error: unknown;
    };

/**
 * Result of one worker iteration. Totals are per-iteration — they reset at
 * the start of each run. The `bytesReclaimed` field is 0 in Plan 4 (same
 * known limitation as Plan 3: `list()` yields hashes only, we don't re-read
 * blob bytes just to measure size).
 */
export interface WorkerStats {
  /** Count of `blob_ready = 0` rows promoted to `blob_ready = 1`. */
  readonly promoted: number;
  /** Count of rows reaped after exhausting `maxRepairAttempts`. */
  readonly terminallyDeleted: number;
  /** Count of `has()` / `delete()` calls that threw (transient backend). */
  readonly transientErrors: number;
  /** Count of `pending_blob_deletes` rows drained this iteration. */
  readonly tombstonesDrained: number;
  /** Reserved; always 0 in Plan 4 (see interface docstring). */
  readonly bytesReclaimed: number;
}
