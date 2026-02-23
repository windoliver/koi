/**
 * Types for the manifest loader output.
 *
 * `LoadedManifest` extends L0's `AgentManifest` with extension fields
 * that exist in koi.yaml but are not part of the core contract.
 */

import type { AgentManifest } from "@koi/core";

/**
 * Typed deploy configuration after validation and defaults.
 */
export interface DeployConfig {
  readonly port: number;
  readonly restart: "on-failure" | "always" | "no";
  readonly restartDelaySec: number;
  readonly envFile?: string | undefined;
  readonly logDir?: string | undefined;
  readonly system: boolean;
}

/**
 * Extension fields that exist in koi.yaml but are outside L0 core contracts.
 * All values are validated by the schema layer.
 */
export interface ManifestExtensions {
  readonly engine?: unknown;
  readonly schedule?: unknown;
  readonly webhooks?: unknown;
  readonly forge?: unknown;
  readonly context?: unknown;
  readonly soul?: unknown;
  readonly user?: unknown;
  readonly deploy?: DeployConfig | undefined;
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
