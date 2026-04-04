/**
 * Memory tool constants — defaults for prefix, limits, and operation list.
 */

/** Default tool name prefix (e.g. "memory_store", "memory_recall"). */
export const DEFAULT_PREFIX = "memory";

/** Default maximum results for memory_recall. */
export const DEFAULT_RECALL_LIMIT = 10;

/** Default maximum results for memory_search. */
export const DEFAULT_SEARCH_LIMIT = 20;

/** All memory tool operations. */
export const MEMORY_OPERATIONS = ["store", "recall", "search", "delete"] as const;
