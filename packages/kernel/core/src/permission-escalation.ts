/**
 * PermissionEscalation — coordinator→worker runtime permission escalation contract (L0).
 *
 * Defines the typed request/decision flow for workers that encounter a capability
 * boundary mid-task and need the coordinator to approve or deny the escalation.
 *
 * Design principles (informed by A2A SEP #1404, GNAP RFC 9635, AgentBond):
 * - Typed request → typed decision: no opaque side channels
 * - Fail-closed on timeout: "expired" is a third decision kind, never an implicit grant
 * - Re-delegation is opt-in and attenuation-only: workers cannot self-amplify scope
 * - Decision is a discriminated union: "approved" carries a granted set; "rejected" and
 *   "expired" carry a reason string for agent-observable structured failure handling
 *
 * Transport is L2: the in-process backing (Promise + callback) is defined in
 * @koi/permission-escalation-local; the Nexus-backed transport is defined in
 * @koi/permission-escalation-nexus (#1526). This file defines only the L0 contract.
 */

import type { AgentId } from "./ecs.js";

// ---------------------------------------------------------------------------
// Permission request
// ---------------------------------------------------------------------------

/**
 * A worker's runtime request for additional capability grants.
 *
 * `requestedGrants` uses string identifiers (e.g., `"db:write"`, `"deploy:prod"`)
 * rather than bare tool names — a grant may cover multiple tools or resource scopes.
 * The coordinator intersects the request against its own grant set and user policy.
 *
 * `purposeStatement` is mandatory for audit: bare grant requests without context
 * lead to rubber-stamping. Coordinators and human reviewers need the "why".
 *
 * `expiresAt` is the worker-declared TTL (Unix ms). The coordinator must reject
 * requests that have already expired when received. Default TTL enforcement is
 * the backing implementation's responsibility.
 */
export interface PermissionRequest {
  /** Unique request ID for idempotency — deduplicates retried requests. */
  readonly requestId: string;
  /** Agent making the request. */
  readonly agentId: AgentId;
  /** Grants requested (e.g. ["db:write", "deploy:prod"]). */
  readonly requestedGrants: readonly string[];
  /** Human-readable audit reason — REQUIRED. Explains why the grant is needed. */
  readonly purposeStatement: string;
  /** Request expiry as Unix timestamp (ms). Fail-closed: expired → rejected. */
  readonly expiresAt: number;
  /** Optional task state snapshot for reviewer context. Opaque — coordinator decides format. */
  readonly context?: unknown;
}

// ---------------------------------------------------------------------------
// Permission decision
// ---------------------------------------------------------------------------

/**
 * The coordinator's decision on a PermissionRequest.
 *
 * Three cases:
 * - "approved": coordinator granted a (possibly narrowed) subset of requested grants.
 *   `grantedGrants` may be a strict subset of `requestedGrants` — workers must not
 *   assume all requested grants were approved.
 * - "rejected": coordinator denied the request. `reason` is returned to the worker's
 *   context window so it can handle the failure gracefully (not silently).
 * - "expired": the request TTL elapsed before the coordinator responded. Distinct from
 *   "rejected" — the worker may retry with a fresh request; a "rejected" should not
 *   be retried without changing the request.
 */
export type PermissionDecision =
  | {
      readonly decision: "approved";
      readonly grantedGrants: readonly string[];
    }
  | {
      readonly decision: "rejected";
      readonly reason: string;
    }
  | {
      readonly decision: "expired";
      readonly reason: string;
    };

// ---------------------------------------------------------------------------
// Escalation contract
// ---------------------------------------------------------------------------

/**
 * Coordinator→worker permission escalation interface.
 *
 * Workers call `request()` with a typed `PermissionRequest` and await a
 * `PermissionDecision`. The coordinator (or a gateway-backed backing) resolves
 * the Promise with the decision.
 *
 * In-process backing: coordinator holds a resolver callback; `request()` registers
 * the request and returns a Promise the coordinator resolves when it decides.
 *
 * Nexus-backed (future, #1526): `request()` sends a gateway frame and awaits the
 * response. Same interface, transport-swappable at assembly.
 */
export interface PermissionEscalation {
  readonly request: (req: PermissionRequest) => Promise<PermissionDecision>;
}
