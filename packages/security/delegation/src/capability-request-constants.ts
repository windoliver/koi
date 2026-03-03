/**
 * Constants for the capability request pull model.
 *
 * Defines message types, response statuses, and defaults for the
 * delegation_request tool and capability request bridge.
 */

/** AgentMessage.type value for capability request messages. */
export const CAPABILITY_REQUEST_TYPE = "capability_request" as const;

/** Possible response statuses for a capability request. */
export const CAPABILITY_RESPONSE_STATUS = {
  GRANTED: "granted",
  DENIED: "denied",
} as const;

/** A capability request response status. */
export type CapabilityResponseStatus =
  (typeof CAPABILITY_RESPONSE_STATUS)[keyof typeof CAPABILITY_RESPONSE_STATUS];

/** Maximum forward depth for bubble-up routing. */
export const MAX_FORWARD_DEPTH = 5;

/** Default timeout (ms) for the delegation_request tool (sender waits). */
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

/** Default timeout (ms) for HITL approval on the receiver side. */
export const DEFAULT_APPROVAL_TIMEOUT_MS = 60_000;
