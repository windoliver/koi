/**
 * ArtifactClient — the universal artifact storage interface.
 *
 * Error semantics:
 * - save() with existing ID → CONFLICT
 * - load() / remove() / update() with missing ID → NOT_FOUND
 * - Invalid input (empty ID, negative limit) → VALIDATION
 * - I/O failures → EXTERNAL (retryable: true)
 * - Corrupt data → INTERNAL
 */

import type { KoiError, Result } from "@koi/core";
import type { Artifact, ArtifactId, ArtifactPage, ArtifactQuery, ArtifactUpdate } from "./types.js";

export interface ArtifactClient {
  readonly save: (artifact: Artifact) => Promise<Result<void, KoiError>>;
  readonly load: (id: ArtifactId) => Promise<Result<Artifact, KoiError>>;
  readonly search: (query: ArtifactQuery) => Promise<Result<ArtifactPage, KoiError>>;
  readonly remove: (id: ArtifactId) => Promise<Result<void, KoiError>>;
  readonly update: (id: ArtifactId, updates: ArtifactUpdate) => Promise<Result<void, KoiError>>;
  readonly exists: (id: ArtifactId) => Promise<Result<boolean, KoiError>>;
}
