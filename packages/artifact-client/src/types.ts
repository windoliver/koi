/**
 * Core types for the artifact storage system.
 */

import type { JsonObject } from "@koi/core";

// ---------------------------------------------------------------------------
// Branded types
// ---------------------------------------------------------------------------

declare const __brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [__brand]: B };

/** Unique identifier for an artifact. */
export type ArtifactId = Brand<string, "ArtifactId">;

/** SHA-256 content hash. */
export type ContentHash = Brand<string, "ContentHash">;

/** Create a branded ArtifactId from a plain string. */
export function artifactId(id: string): ArtifactId {
  return id as ArtifactId;
}

/** Create a branded ContentHash from a plain string. */
export function contentHash(hash: string): ContentHash {
  return hash as ContentHash;
}

// ---------------------------------------------------------------------------
// Core artifact
// ---------------------------------------------------------------------------

/** A stored artifact with universal metadata fields. */
export interface Artifact {
  readonly id: ArtifactId;
  readonly name: string;
  readonly description: string;
  /** Artifact payload (stringified). */
  readonly content: string;
  /** MIME type (e.g., "application/json", "text/markdown"). */
  readonly contentType: string;
  /** SHA-256 of content, computed at save time. */
  readonly contentHash?: ContentHash | undefined;
  /** Content size in bytes (UTF-8). */
  readonly sizeBytes: number;
  /** Tag-based discovery (e.g., "forge:kind:tool"). */
  readonly tags: readonly string[];
  /** Domain-specific extensible data. */
  readonly metadata: JsonObject;
  /** Agent or user who created this artifact. */
  readonly createdBy: string;
  /** Unix timestamp in milliseconds. */
  readonly createdAt: number;
  /** Unix timestamp in milliseconds. */
  readonly updatedAt: number;
}

// ---------------------------------------------------------------------------
// Query & pagination
// ---------------------------------------------------------------------------

/** Search filters for artifact queries. */
export interface ArtifactQuery {
  /** AND-match: artifact must have ALL specified tags. */
  readonly tags?: readonly string[] | undefined;
  readonly createdBy?: string | undefined;
  readonly contentType?: string | undefined;
  /** Substring match on name + description. */
  readonly textSearch?: string | undefined;
  /** Max results to return. Default: 100. */
  readonly limit?: number | undefined;
  /** Number of results to skip. Default: 0. */
  readonly offset?: number | undefined;
  /** Sort field. Default: "createdAt". */
  readonly sortBy?: "createdAt" | "updatedAt" | "name" | undefined;
  /** Sort direction. Default: "desc". */
  readonly sortOrder?: "asc" | "desc" | undefined;
}

/** Partial update — only provided fields are changed. */
export interface ArtifactUpdate {
  readonly name?: string | undefined;
  readonly description?: string | undefined;
  readonly content?: string | undefined;
  readonly contentType?: string | undefined;
  readonly tags?: readonly string[] | undefined;
  readonly metadata?: JsonObject | undefined;
}

/** Paginated search result. */
export interface ArtifactPage {
  readonly items: readonly Artifact[];
  readonly total: number;
  readonly offset: number;
  readonly limit: number;
}
