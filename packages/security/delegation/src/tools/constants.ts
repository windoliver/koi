/**
 * Constants for delegation tool factories.
 */

/** Default tool name prefix for delegation tools. */
export const DEFAULT_PREFIX = "delegation" as const;

/** Supported delegation tool operations. */
export const OPERATIONS = ["grant", "revoke", "list", "request", "check"] as const;

/** A delegation tool operation name. */
export type DelegationOperation = (typeof OPERATIONS)[number];
