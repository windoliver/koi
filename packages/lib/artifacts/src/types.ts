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
  readonly blobDir: string;
  readonly durability?: "process" | "os";
  readonly maxArtifactBytes?: number;
  /**
   * Terminal-delete threshold for confirmed-missing blobs during startup
   * recovery. Default 10. Lower values terminal-delete faster (tests use
   * 2); higher values tolerate longer backend outages across restarts.
   */
  readonly maxRepairAttempts?: number;
  /**
   * Lifecycle policy: TTL, quota, and per-name retention. Fields are all
   * optional; when present each must be a finite positive integer. Validated
   * at construction (Plan 3 — #1920). `ttlMs` is frozen onto each row's
   * `expires_at` at save time; later policy changes never recompute it.
   */
  readonly policy?: LifecyclePolicy;
  // Plan 5 (#1922) will add `blobStore: BlobStore` for pluggable backends —
  // still omitted from the public surface so the type never advertises a
  // field that would be rejected at runtime.
}
