/**
 * VersionIndex contract — version label → BrickId resolution.
 *
 * Orthogonal to ForgeStore and BrickRegistry (like AdvisoryLock).
 * Maps human-readable version labels to content-addressed BrickIds,
 * enabling reproducible agent assembly and publisher attribution.
 *
 * Reader/Writer split follows the SkillRegistry/BrickRegistry pattern.
 */

import type { BrickId } from "./brick-snapshot.js";
import type { KoiError, Result } from "./errors.js";
import type { BrickKind } from "./forge-types.js";
import type { PublisherId, VersionChangeEvent, VersionEntry } from "./version-types.js";

// ---------------------------------------------------------------------------
// Reader — query version bindings
// ---------------------------------------------------------------------------

/** Read-only interface for resolving version labels to BrickIds. */
export interface VersionIndexReader {
  /**
   * Resolve an exact version label to its entry.
   * Returns NOT_FOUND if the label does not exist or was yanked.
   */
  readonly resolve: (
    name: string,
    kind: BrickKind,
    version: string,
  ) => Result<VersionEntry, KoiError> | Promise<Result<VersionEntry, KoiError>>;

  /**
   * Resolve the latest (most recently published) version.
   * Returns NOT_FOUND if no versions exist for this brick.
   */
  readonly resolveLatest: (
    name: string,
    kind: BrickKind,
  ) => Result<VersionEntry, KoiError> | Promise<Result<VersionEntry, KoiError>>;

  /**
   * List all versions for a brick, newest first (by publishedAt).
   * Returns NOT_FOUND if no versions exist for this brick.
   */
  readonly listVersions: (
    name: string,
    kind: BrickKind,
  ) =>
    | Result<readonly VersionEntry[], KoiError>
    | Promise<Result<readonly VersionEntry[], KoiError>>;

  /**
   * Subscribe to version change events for cache invalidation.
   * Returns an unsubscribe function. Optional — implementations
   * that don't support push notifications may omit this.
   */
  readonly onChange?: (listener: (event: VersionChangeEvent) => void) => () => void;
}

// ---------------------------------------------------------------------------
// Writer — mutate version bindings
// ---------------------------------------------------------------------------

/** Write interface for managing version label → BrickId mappings. */
export interface VersionIndexWriter {
  /**
   * Publish a version label binding.
   *
   * - Returns CONFLICT if the same label maps to a different BrickId
   *   (content-addressed hashes are immutable — re-binding is a shadow).
   * - Idempotent for the same (name, kind, version, brickId) tuple.
   * - Returns VALIDATION if name or version is empty/whitespace-only.
   */
  readonly publish: (
    name: string,
    kind: BrickKind,
    version: string,
    brickId: BrickId,
    publisher: PublisherId,
  ) => Result<VersionEntry, KoiError> | Promise<Result<VersionEntry, KoiError>>;

  /**
   * Soft-deprecate a version — still resolvable, but flagged.
   * Returns NOT_FOUND if the version label does not exist.
   * Idempotent — deprecating an already-deprecated version succeeds.
   */
  readonly deprecate: (
    name: string,
    kind: BrickKind,
    version: string,
  ) => Result<void, KoiError> | Promise<Result<void, KoiError>>;

  /**
   * Hard-remove a version label — resolve returns NOT_FOUND after.
   * Returns NOT_FOUND if the version label does not exist.
   */
  readonly yank: (
    name: string,
    kind: BrickKind,
    version: string,
  ) => Result<void, KoiError> | Promise<Result<void, KoiError>>;
}

// ---------------------------------------------------------------------------
// Backend — combined reader + writer
// ---------------------------------------------------------------------------

/** Full VersionIndex backend — implements both read and write operations. */
export interface VersionIndexBackend extends VersionIndexReader, VersionIndexWriter {}
