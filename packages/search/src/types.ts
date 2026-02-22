/**
 * @koi/search — Search value types (Layer 2)
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

/** Document for indexing */
export interface IndexDocument<T = unknown> {
  readonly id: string;
  readonly content: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly embedding?: readonly number[];
  readonly data?: T;
}
