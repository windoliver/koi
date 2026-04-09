/**
 * Public types for @koi/plugins.
 */

import type { KoiError } from "@koi/core";

// ---------------------------------------------------------------------------
// Plugin source tier
// ---------------------------------------------------------------------------

/**
 * The origin tier of a discovered plugin.
 * Precedence (highest first): managed > user > bundled.
 */
export type PluginSource = "bundled" | "user" | "managed";

/**
 * Source priority — lower number = higher precedence.
 * Used during shadowing resolution.
 */
export const SOURCE_PRIORITY: Readonly<Record<PluginSource, number>> = Object.freeze({
  managed: 0,
  user: 1,
  bundled: 2,
} as const);

// ---------------------------------------------------------------------------
// Plugin ID — branded string (plugin name, since shadowing resolves one winner)
// ---------------------------------------------------------------------------

declare const __pluginIdBrand: unique symbol;

export type PluginId = string & { readonly [__pluginIdBrand]: "PluginId" };

// ---------------------------------------------------------------------------
// Plugin manifest (validated shape from plugin.json)
// ---------------------------------------------------------------------------

export interface PluginManifest {
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly author?: string | undefined;
  readonly keywords?: readonly string[] | undefined;
  readonly skills?: readonly string[] | undefined;
  readonly hooks?: string | undefined;
  readonly mcpServers?: string | undefined;
  readonly middleware?: readonly string[] | undefined;
}

// ---------------------------------------------------------------------------
// Plugin metadata (discovery result — no path resolution)
// ---------------------------------------------------------------------------

export interface PluginMeta {
  readonly id: PluginId;
  readonly name: string;
  readonly source: PluginSource;
  readonly version: string;
  readonly description: string;
  readonly dirPath: string;
  readonly manifest: PluginManifest;
  readonly available: boolean;
}

// ---------------------------------------------------------------------------
// Loaded plugin (fully resolved with validated paths)
// ---------------------------------------------------------------------------

export interface LoadedPlugin extends PluginMeta {
  readonly skillPaths: readonly string[];
  readonly hookConfigPath?: string | undefined;
  readonly mcpConfigPath?: string | undefined;
  readonly middlewareNames: readonly string[];
}

// ---------------------------------------------------------------------------
// Per-plugin discovery error
// ---------------------------------------------------------------------------

export interface PluginError {
  readonly dirPath: string;
  readonly source: PluginSource;
  readonly error: KoiError;
  /** Plugin name if known (from validated manifest). Used for fail-closed shadowing. */
  readonly pluginName?: string | undefined;
}

// ---------------------------------------------------------------------------
// Discovery result
// ---------------------------------------------------------------------------

export interface DiscoverResult {
  readonly plugins: readonly PluginMeta[];
  readonly errors: readonly PluginError[];
}

// ---------------------------------------------------------------------------
// Registry config
// ---------------------------------------------------------------------------

export interface PluginRegistryConfig {
  /** Root directory for bundled plugins. Pass null to disable. */
  readonly bundledRoot?: string | null;
  /** Root directory for user-installed plugins. */
  readonly userRoot?: string;
  /** Root directory for managed (organization) plugins. */
  readonly managedRoot?: string;
  /** Optional availability gate — evaluated at discovery time. */
  readonly isAvailable?: (manifest: PluginManifest) => boolean;
}
