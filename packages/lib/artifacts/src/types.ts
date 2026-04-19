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
  readonly close: () => Promise<void>;
}

export interface ArtifactStoreConfig {
  readonly dbPath: string;
  readonly blobDir: string;
  readonly blobStore?: BlobStore;
  readonly policy?: LifecyclePolicy;
  readonly durability?: "process" | "os";
  readonly maxArtifactBytes?: number;
}
