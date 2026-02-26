/**
 * Constants for @koi/webhook-provider — tool names and defaults.
 */

/** Default tool name prefix for webhook tools. */
export const DEFAULT_PREFIX = "webhook" as const;

/** All webhook operation names. */
export const OPERATIONS = ["list", "status"] as const;

export type WebhookOperation = (typeof OPERATIONS)[number];
