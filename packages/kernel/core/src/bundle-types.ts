/**
 * Agent bundle types — portable export/import envelope.
 *
 * Defines the `.koibundle` format: a JSON artifact containing an agent's
 * manifest + all referenced bricks. Follows the BrickId/SnapshotId pattern
 * for branded identity.
 */

import type { BrickArtifact } from "./brick-store.js";

// ---------------------------------------------------------------------------
// Branded type
// ---------------------------------------------------------------------------

declare const __bundleIdBrand: unique symbol;

/**
 * Branded string for bundle identity.
 * Prevents mixing bundle IDs with other string-typed IDs at compile time.
 */
export type BundleId = string & { readonly [__bundleIdBrand]: "BundleId" };

/** Create a BundleId from a raw string. */
export function bundleId(raw: string): BundleId {
  return raw as BundleId;
}

// ---------------------------------------------------------------------------
// Format version
// ---------------------------------------------------------------------------

/** Current `.koibundle` format version. Incremented on breaking format changes. */
export const BUNDLE_FORMAT_VERSION = "1" as const;

// ---------------------------------------------------------------------------
// AgentBundle — the portable artifact
// ---------------------------------------------------------------------------

/**
 * Portable agent bundle — serializable envelope containing an agent's
 * full definition (manifest + forged bricks).
 *
 * Design: Docker-style export/import. Content-addressed for integrity.
 */
export interface AgentBundle {
  readonly version: typeof BUNDLE_FORMAT_VERSION;
  readonly id: BundleId;
  readonly name: string;
  readonly description: string;
  readonly manifestYaml: string;
  readonly bricks: readonly BrickArtifact[];
  readonly contentHash: string;
  readonly createdAt: number;
  readonly metadata?: Readonly<Record<string, unknown>>;
}
