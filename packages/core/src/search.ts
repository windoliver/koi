/**
 * @koi/core — Search value types (Layer 0)
 *
 * All types are readonly, no runtime code.
 */

/** Score normalized to [0, 1] */
export type SearchScore = number;

/** What the caller wants */
export interface SearchQuery {
  readonly text: string;
  readonly filter?: SearchFilter;
  readonly limit: number;
  readonly offset?: number;
  readonly cursor?: string;
  readonly minScore?: SearchScore;
}

/** Single search result */
export interface SearchResult<T = unknown> {
  readonly id: string;
  readonly score: SearchScore;
  readonly content: string;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly source: string;
  readonly data?: T;
}

/** Paginated response */
export interface SearchPage<T = unknown> {
  readonly results: readonly SearchResult<T>[];
  readonly total?: number;
  readonly cursor?: string;
  readonly hasMore: boolean;
}

/** Composable filter tree (discriminated union) */
export type SearchFilter =
  | { readonly kind: "eq"; readonly field: string; readonly value: unknown }
  | { readonly kind: "ne"; readonly field: string; readonly value: unknown }
  | { readonly kind: "gt"; readonly field: string; readonly value: number }
  | { readonly kind: "lt"; readonly field: string; readonly value: number }
  | {
      readonly kind: "in";
      readonly field: string;
      readonly values: readonly unknown[];
    }
  | { readonly kind: "and"; readonly filters: readonly SearchFilter[] }
  | { readonly kind: "or"; readonly filters: readonly SearchFilter[] }
  | { readonly kind: "not"; readonly filter: SearchFilter };

/** Score normalization method */
export type ScoreNormalizer = "min_max" | "z_score" | "l2";

/** Fusion function signature for custom strategies */
export type FusionFunction = (
  rankedLists: readonly (readonly SearchResult[])[],
  limit: number,
) => readonly SearchResult[];

/** Fusion strategy (discriminated union — logic lives in L2) */
export type FusionStrategy =
  | { readonly kind: "rrf"; readonly k?: number }
  | {
      readonly kind: "weighted_rrf";
      readonly k?: number;
      readonly weights: readonly number[];
    }
  | {
      readonly kind: "linear";
      readonly weights: readonly number[];
      readonly normalizer?: ScoreNormalizer;
    }
  | { readonly kind: "custom"; readonly fuse: FusionFunction };

/** Document for indexing */
export interface IndexDocument<T = unknown> {
  readonly id: string;
  readonly content: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly embedding?: readonly number[];
  readonly data?: T;
}

/** Search errors (expected failures — typed values, not thrown) */
export type SearchError =
  | { readonly kind: "not_found"; readonly query: string }
  | { readonly kind: "timeout"; readonly ms: number }
  | {
      readonly kind: "backend_unavailable";
      readonly backend: string;
      readonly cause?: unknown;
    }
  | { readonly kind: "invalid_query"; readonly reason: string };

/** Result type for search operations */
export type SearchOk<T> = { readonly ok: true; readonly value: T };
export type SearchErr = { readonly ok: false; readonly error: SearchError };
export type SearchOutcome<T> = SearchOk<T> | SearchErr;
