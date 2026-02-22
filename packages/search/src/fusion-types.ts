/**
 * Fusion algorithm types — L2 search-specific.
 *
 * These types define how multiple ranked lists are combined into a single
 * result set. They are NOT part of L0 (@koi/core) because fusion strategies
 * are implementation details of the search package.
 */

import type { SearchResult } from "./types.js";

/** Score normalizer names for linear combination fusion */
export type ScoreNormalizer = "min_max" | "z_score" | "l2";

/** Custom fusion function signature */
export type FusionFunction = (
  rankedLists: readonly (readonly SearchResult[])[],
  limit: number,
) => readonly SearchResult[];

/** Discriminated union of supported fusion strategies */
export type FusionStrategy =
  | { readonly kind: "rrf"; readonly k?: number }
  | { readonly kind: "weighted_rrf"; readonly k?: number; readonly weights: readonly number[] }
  | {
      readonly kind: "linear";
      readonly weights: readonly number[];
      readonly normalizer?: ScoreNormalizer;
    }
  | { readonly kind: "custom"; readonly fuse: FusionFunction };
