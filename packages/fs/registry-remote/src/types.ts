/**
 * Types for the remote brick registry client.
 *
 * Defines configuration, publish options/results, cache entries,
 * and dependency check results.
 */

import type { BrickArtifact, BrickKind } from "@koi/core";

// ---------------------------------------------------------------------------
// Remote registry configuration
// ---------------------------------------------------------------------------

export interface RemoteRegistryConfig {
  /** Base URL of the community registry API (e.g., "https://registry.koi.dev"). */
  readonly baseUrl: string;
  /** Auth token sent as Bearer token in Authorization header. Optional for read-only access. */
  readonly authToken?: string | undefined;
  /** Request timeout in milliseconds. Default: 10_000. */
  readonly timeoutMs?: number | undefined;
  /** Injectable fetch function for testing. Default: globalThis.fetch. */
  readonly fetch?: typeof globalThis.fetch | undefined;
  /** Cache TTL in milliseconds. Default: 30_000 (30s). */
  readonly cacheTtlMs?: number | undefined;
  /** Maximum number of cache entries. Default: 100. */
  readonly maxCacheEntries?: number | undefined;
}

// ---------------------------------------------------------------------------
// Publish
// ---------------------------------------------------------------------------

/** Integrity verifier — injectable for testing. */
export type IntegrityVerifier = (brick: BrickArtifact) => IntegrityCheckResult;

export interface IntegrityCheckResult {
  readonly ok: boolean;
  readonly kind: string;
}

export interface PublishOptions {
  /** Base URL of the community registry API. */
  readonly registryUrl: string;
  /** Auth token for publishing. Required. */
  readonly authToken: string;
  /** Request timeout in milliseconds. Default: 30_000. */
  readonly timeoutMs?: number | undefined;
  /** Injectable fetch function for testing. Default: globalThis.fetch. */
  readonly fetch?: typeof globalThis.fetch | undefined;
  /** Injectable integrity verifier. Default: passthrough (callers should provide a real one). */
  readonly verifyIntegrity?: IntegrityVerifier | undefined;
}

export interface PublishResult {
  /** The published brick's ID. */
  readonly id: string;
  /** The brick kind. */
  readonly kind: BrickKind;
  /** The brick name. */
  readonly name: string;
  /** Full URL to the published brick in the registry. */
  readonly url: string;
  /** ISO 8601 timestamp of publication. */
  readonly publishedAt: string;
}

// ---------------------------------------------------------------------------
// HTTP cache (ETag + TTL)
// ---------------------------------------------------------------------------

export interface CachedResponse {
  readonly etag?: string | undefined;
  readonly body: unknown;
  readonly cachedAt: number;
}

// ---------------------------------------------------------------------------
// Dependency check
// ---------------------------------------------------------------------------

export interface MissingDependency {
  readonly kind: "tool" | "agent" | "bin" | "env";
  readonly name: string;
  /** Whether the dependency was found in the remote registry. */
  readonly availableRemotely: boolean;
}

export type DependencyCheckResult =
  | { readonly satisfied: true }
  | { readonly satisfied: false; readonly missing: readonly MissingDependency[] };

// ---------------------------------------------------------------------------
// Batch check (remote endpoint result)
// ---------------------------------------------------------------------------

export interface BatchCheckResult {
  /** Hashes that exist in the remote registry. */
  readonly existing: readonly string[];
  /** Hashes not found in the remote registry. */
  readonly missing: readonly string[];
}

// ---------------------------------------------------------------------------
// Default values
// ---------------------------------------------------------------------------

export const DEFAULT_TIMEOUT_MS = 10_000;
export const DEFAULT_PUBLISH_TIMEOUT_MS = 30_000;
export const DEFAULT_CACHE_TTL_MS = 30_000;
export const DEFAULT_MAX_CACHE_ENTRIES = 100;

// ---------------------------------------------------------------------------
// Helper: validated fetch response with ETag metadata
// ---------------------------------------------------------------------------

export interface FetchResultOk {
  readonly status: number;
  readonly body: unknown;
  readonly etag?: string | undefined;
}

/**
 * Brick artifact type re-exported for convenience within this package.
 * Canonical definition lives in @koi/core.
 */
export type { BrickArtifact };
