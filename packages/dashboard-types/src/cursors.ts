/**
 * Cursor-based pagination types for Phase 3 conversation history.
 * Defined now for API stability — unused until Phase 3.
 */

export interface CursorRequest {
  readonly cursor?: string;
  readonly limit?: number;
}

export interface CursorPage<T> {
  readonly items: readonly T[];
  readonly nextCursor?: string;
  readonly hasMore: boolean;
}
