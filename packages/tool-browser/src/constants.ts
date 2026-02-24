/**
 * Constants for @koi/tool-browser — tool names, operations, and SDK mappings.
 */

/** Default tool name prefix for browser tools. */
export const DEFAULT_PREFIX = "browser" as const;

/**
 * All browser operation names in default order.
 * NOTE: "evaluate" is intentionally excluded from the default set.
 * It uses `promoted` trust tier and must be explicitly opted in.
 */
export const OPERATIONS = [
  "snapshot",
  "navigate",
  "click",
  "hover",
  "press",
  "type",
  "select",
  "fill_form",
  "scroll",
  "screenshot",
  "wait",
  "tab_new",
  "tab_close",
  "tab_focus",
] as const;

/** All operations including the promoted-tier evaluate. */
export const ALL_OPERATIONS = [
  "snapshot",
  "navigate",
  "click",
  "hover",
  "press",
  "type",
  "select",
  "fill_form",
  "scroll",
  "screenshot",
  "wait",
  "tab_new",
  "tab_close",
  "tab_focus",
  "evaluate",
] as const;

export type BrowserOperation = (typeof ALL_OPERATIONS)[number];

/**
 * The `evaluate` operation uses `promoted` trust tier.
 * It is excluded from OPERATIONS and must be explicitly added.
 */
export const EVALUATE_OPERATION = "evaluate" as const;

/** Trust tier for evaluate — higher than the default "verified". */
export const EVALUATE_TRUST_TIER = "promoted" as const;
