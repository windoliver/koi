/**
 * Shared types for the edit-match package.
 */

/** The strategy that produced a successful match. */
export type MatchStrategy = "exact" | "whitespace-normalized" | "indentation-flexible" | "fuzzy";

/** Result of a successful search-block match against source code. */
export interface MatchResult {
  /** Whether a match was found. */
  readonly found: true;
  /** Zero-based character offset where the match starts in the source. */
  readonly startIndex: number;
  /** Zero-based character offset where the match ends (exclusive) in the source. */
  readonly endIndex: number;
  /** Which strategy produced the match. */
  readonly strategy: MatchStrategy;
  /** Confidence score from 0 to 1 (exact = 1.0, fuzzy = 0.8+). */
  readonly confidence: number;
}

/** Result of applying an edit operation. */
export interface EditResult {
  /** The source after applying the edit. */
  readonly content: string;
  /** The match that was used to apply the edit. */
  readonly match: MatchResult;
}
