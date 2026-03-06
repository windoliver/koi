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

/** Manifest-level soul/user config: string path/inline or object with path + maxTokens. */
export type SoulUserConfig = string | { readonly path: string; readonly maxTokens?: number };

// ---------------------------------------------------------------------------
// Scope configuration — declarative subsystem boundaries
// ---------------------------------------------------------------------------

/** Filesystem scope: root path + read-only/read-write mode. */
export interface ManifestFileSystemScope {
  readonly root: string;
  readonly mode?: "rw" | "ro" | undefined;
}

/** Browser scope: navigation security + trust tier. */
export interface ManifestBrowserScope {
  readonly allowedProtocols?: readonly string[] | undefined;
  readonly allowedDomains?: readonly string[] | undefined;
  readonly blockPrivateAddresses?: boolean | undefined;
  readonly sandbox?: boolean | undefined;
}

/** Credentials scope: key glob pattern filter. */
export interface ManifestCredentialsScope {
  readonly keyPattern: string;
}

/** Memory scope: namespace isolation. */
export interface ManifestMemoryScope {
  readonly namespace: string;
}

/** Declarative scope section in koi.yaml — agents declare their boundaries. */
export interface ManifestScopeConfig {
  readonly filesystem?: ManifestFileSystemScope | undefined;
  readonly browser?: ManifestBrowserScope | undefined;
  readonly credentials?: ManifestCredentialsScope | undefined;
  readonly memory?: ManifestMemoryScope | undefined;
}

/**
 * Extension fields that exist in koi.yaml but are outside L0 core contracts.
 * All values are validated by the schema layer.
 */
/** Nexus backend connection config in the manifest. */
export interface NexusManifestConfig {
  readonly url?: string | undefined;
}

export interface ManifestExtensions {
  readonly engine?: unknown;
  readonly schedule?: unknown;
  readonly webhooks?: unknown;
  readonly forge?: unknown;
  readonly context?: unknown;
  readonly soul?: SoulUserConfig | undefined;
  readonly user?: SoulUserConfig | undefined;
  readonly deploy?: DeployConfig | undefined;
  readonly scope?: ManifestScopeConfig | undefined;
  readonly nexus?: NexusManifestConfig | undefined;
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
