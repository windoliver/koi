/**
 * Catalog — unified capability discovery across all sources.
 *
 * Types for the CatalogReader contract: search + get across bundled,
 * forged, MCP, and skill-registry sources. Implementation lives in
 * @koi/catalog (L2).
 *
 * Exception: ALL_CATALOG_SOURCES and DEFAULT_CATALOG_SEARCH_LIMIT are
 * pure readonly data constants derived from L0 type definitions.
 */

import type { KoiError, Result } from "./errors.js";
import type { BrickKind } from "./forge-types.js";

// ---------------------------------------------------------------------------
// Source taxonomy
// ---------------------------------------------------------------------------

export type CatalogSource = "bundled" | "forged" | "mcp" | "skill-registry";

export const ALL_CATALOG_SOURCES: readonly CatalogSource[] = [
  "bundled",
  "forged",
  "mcp",
  "skill-registry",
] as const;

// ---------------------------------------------------------------------------
// Catalog entry — progressive disclosure tier (lighter than BrickArtifact)
// ---------------------------------------------------------------------------

export interface CatalogEntry {
  /** Source-prefixed name, e.g. "bundled:@koi/middleware-pii". */
  readonly name: string;
  readonly kind: BrickKind;
  readonly source: CatalogSource;
  readonly description: string;
  readonly sandbox?: boolean;
  readonly version?: string;
  readonly tags?: readonly string[];
  /** Composite fitness score in [0, 1]. Undefined if brick has no usage data. */
  readonly fitnessScore?: number;
}

// ---------------------------------------------------------------------------
// Query + pagination
// ---------------------------------------------------------------------------

export interface CatalogQuery {
  readonly kind?: BrickKind;
  readonly text?: string;
  readonly source?: CatalogSource;
  readonly tags?: readonly string[];
  readonly limit?: number;
  /** Reserved for future cursor-based pagination. */
  readonly cursor?: string;
}

export const DEFAULT_CATALOG_SEARCH_LIMIT: 50 = 50;

// ---------------------------------------------------------------------------
// Page result with partial-failure support
// ---------------------------------------------------------------------------

export interface CatalogSourceError {
  readonly source: CatalogSource;
  readonly error: KoiError;
}

export interface CatalogPage {
  readonly items: readonly CatalogEntry[];
  /** Unused initially — interface-ready for cursor pagination. */
  readonly cursor?: string;
  readonly total?: number;
  readonly sourceErrors?: readonly CatalogSourceError[];
}

// ---------------------------------------------------------------------------
// Reader contract
// ---------------------------------------------------------------------------

export interface CatalogReader {
  readonly search: (query: CatalogQuery) => CatalogPage | Promise<CatalogPage>;
  readonly get: (
    name: string,
  ) => Result<CatalogEntry, KoiError> | Promise<Result<CatalogEntry, KoiError>>;
  readonly onChange?: (listener: () => void) => () => void;
}
