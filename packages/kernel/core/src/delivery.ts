/**
 * Delivery policy types — controls how spawned child agent results
 * flow to the parent agent.
 *
 * Three modes:
 * - `streaming`: Events flow inline (current behavior, zero overhead)
 * - `deferred`: Consume child events in background, push final output to parent inbox
 * - `on_demand`: Consume in background, write RunReport to ReportStore, parent pulls
 *
 * Exception: DEFAULT_DELIVERY_POLICY is a pure readonly data constant.
 * Exception: isDeliveryPolicy is a pure type guard (side-effect-free).
 */

import type { InboxMode } from "./inbox.js";

// ---------------------------------------------------------------------------
// Policy variants
// ---------------------------------------------------------------------------

export interface StreamingDeliveryPolicy {
  readonly kind: "streaming";
}

export interface DeferredDeliveryPolicy {
  readonly kind: "deferred";
  /** Which inbox mode to use when pushing to parent. Default: "collect". */
  readonly inboxMode?: InboxMode | undefined;
}

export interface OnDemandDeliveryPolicy {
  readonly kind: "on_demand";
}

// ---------------------------------------------------------------------------
// Union + default
// ---------------------------------------------------------------------------

export type DeliveryPolicy =
  | StreamingDeliveryPolicy
  | DeferredDeliveryPolicy
  | OnDemandDeliveryPolicy;

export const DEFAULT_DELIVERY_POLICY: DeliveryPolicy = Object.freeze({
  kind: "streaming",
} as const);

// ---------------------------------------------------------------------------
// Type guard
// ---------------------------------------------------------------------------

export function isDeliveryPolicy(value: unknown): value is DeliveryPolicy {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return v.kind === "streaming" || v.kind === "deferred" || v.kind === "on_demand";
}
