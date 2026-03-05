/**
 * Constants for memory provider tools.
 */

import type { ToolPolicy } from "@koi/core";
import { DEFAULT_UNSANDBOXED_POLICY } from "@koi/core";

/** Default tool name prefix. */
export const DEFAULT_PREFIX = "memory" as const;

/** All supported memory operations. */
export const MEMORY_OPERATIONS = ["store", "recall", "search"] as const;
export type MemoryOperation = (typeof MEMORY_OPERATIONS)[number];

/** Default maximum results for recall queries. */
export const DEFAULT_RECALL_LIMIT = 10;

/** Default maximum results for search queries. */
export const DEFAULT_SEARCH_LIMIT = 20;

/** Default policy for memory tools. */
export const DEFAULT_POLICY: ToolPolicy = DEFAULT_UNSANDBOXED_POLICY;
