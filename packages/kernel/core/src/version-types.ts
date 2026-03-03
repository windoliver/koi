/**
 * Version types — version labels + publisher identity.
 *
 * Shared types used by VersionIndex and assembly configs for
 * versioned brick resolution. Enables human-readable version labels
 * over content-addressed BrickIds and publisher attribution.
 *
 * Exception: `publisherId()` is a branded type constructor (zero-logic
 * identity cast), permitted in L0 per architecture doc.
 */

import type { BrickId } from "./brick-snapshot.js";
import type { BrickKind } from "./forge-types.js";

// ---------------------------------------------------------------------------
// Branded types
// ---------------------------------------------------------------------------

declare const __publisherIdBrand: unique symbol;

/**
 * Branded string for publisher identity.
 * Prevents mixing publisher IDs with other string-typed IDs at compile time.
 */
export type PublisherId = string & { readonly [__publisherIdBrand]: "PublisherId" };

/** Create a PublisherId from a raw string. */
export function publisherId(raw: string): PublisherId {
  return raw as PublisherId;
}

// ---------------------------------------------------------------------------
// VersionEntry — a single version label binding
// ---------------------------------------------------------------------------

/** A version label bound to a content-addressed BrickId. */
export interface VersionEntry {
  /** Human-readable version label (e.g., "1.0.0", "beta"). */
  readonly version: string;
  /** Content-addressed brick identity this label resolves to. */
  readonly brickId: BrickId;
  /** Who published this version. */
  readonly publisher: PublisherId;
  /** Unix epoch ms when this version was published. */
  readonly publishedAt: number;
  /** Soft-deprecated — still resolvable but flagged for consumers. */
  readonly deprecated?: boolean;
}

// ---------------------------------------------------------------------------
// VersionedBrickRef — manifest-level version request
// ---------------------------------------------------------------------------

/** What manifests use to request a versioned brick. */
export interface VersionedBrickRef {
  readonly name: string;
  readonly kind: BrickKind;
  /** Exact version label. If omitted, resolve latest. */
  readonly version?: string;
  /** Optional publisher filter — only resolve versions from this publisher. */
  readonly publisher?: PublisherId;
}

// ---------------------------------------------------------------------------
// Change events — for cache invalidation and audit
// ---------------------------------------------------------------------------

/** Kind of version change event. */
export type VersionChangeKind = "published" | "deprecated" | "yanked";

/** Emitted when a version binding changes. */
export interface VersionChangeEvent {
  readonly kind: VersionChangeKind;
  readonly brickKind: BrickKind;
  readonly name: string;
  readonly version: string;
  readonly brickId: BrickId;
  readonly publisher: PublisherId;
}

// ---------------------------------------------------------------------------
// ShadowWarning — version label re-bind detection
// ---------------------------------------------------------------------------

/** Emitted when a version label would re-bind to different content. */
export interface ShadowWarning {
  readonly name: string;
  readonly kind: BrickKind;
  readonly version: string;
  readonly existingBrickId: BrickId;
  readonly newBrickId: BrickId;
}
