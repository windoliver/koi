/**
 * Types for the manifest loader output.
 *
 * `LoadedManifest` extends L0's `AgentManifest` with extension fields
 * that exist in koi.yaml but are not part of the core contract.
 */

import type { AgentManifest } from "@koi/core";

/**
 * Extension fields that exist in koi.yaml but are outside L0 core contracts.
 * All values are `unknown` — consumers must validate/narrow at their layer.
 */
export interface ManifestExtensions {
  readonly engine?: unknown;
  readonly schedule?: unknown;
  readonly webhooks?: unknown;
  readonly forge?: unknown;
}

/**
 * The fully loaded and validated agent manifest.
 * Combines L0 `AgentManifest` with extension fields.
 */
export type LoadedManifest = AgentManifest & ManifestExtensions;

/** A warning produced during manifest loading (non-fatal). */
export interface ManifestWarning {
  readonly path: string;
  readonly message: string;
  readonly suggestion?: string;
}

/** Successful result of loading a manifest. */
export interface LoadResult {
  readonly manifest: LoadedManifest;
  readonly warnings: readonly ManifestWarning[];
}
