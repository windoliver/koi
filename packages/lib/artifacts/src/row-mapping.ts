/**
 * Shared row → Artifact mapping. Used by save.ts, get.ts, list.ts.
 */

import type { SessionId } from "@koi/core";
import { type ArtifactId, artifactId } from "@koi/core";
import type { Artifact } from "./types.js";

export interface ArtifactRow {
  readonly id: string;
  readonly session_id: string;
  readonly name: string;
  readonly version: number;
  readonly mime_type: string;
  readonly size: number;
  readonly content_hash: string;
  readonly tags: string;
  readonly created_at: number;
  readonly expires_at: number | null;
}

export function rowToArtifact(row: ArtifactRow): Artifact {
  return {
    id: artifactId(row.id),
    sessionId: row.session_id as SessionId,
    name: row.name,
    version: row.version,
    mimeType: row.mime_type,
    size: row.size,
    contentHash: row.content_hash,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    tags: JSON.parse(row.tags) as ReadonlyArray<string>,
  };
}

export const ARTIFACT_COLUMNS = `id, session_id, name, version, mime_type, size, content_hash, tags, created_at, expires_at`;

// Unused here — kept for symmetry if subsequent tasks need the unused import
export type { ArtifactId };
