/**
 * Delegation types — monotonic attenuation tokens for agent-to-agent
 * permission delegation with chain tracking and cascading revocation.
 *
 * All types are immutable (readonly). No runtime code except the branded
 * type constructor for DelegationId.
 */

import type { PermissionConfig } from "./assembly.js";
import type { AgentId } from "./ecs.js";

// ---------------------------------------------------------------------------
// Capability proof — replaces opaque signature: string
// ---------------------------------------------------------------------------

/**
 * Cryptographic proof backing a delegation grant or capability token.
 *
 * - `hmac-sha256`: HMAC-SHA256 digest for root→engine internal auth.
 *   The secret is known only to the issuing engine instance.
 * - `ed25519`: Ed25519 signature for agent-to-agent delegation chains.
 *   Provides cryptographic unforgeability without a shared secret.
 * - `nexus`: Nexus-issued opaque token for external authorization services.
 *   Interface defined here; L2 backend implementation deferred to v2.
 */
export type CapabilityProof =
  | { readonly kind: "hmac-sha256"; readonly digest: string }
  | { readonly kind: "ed25519"; readonly publicKey: string; readonly signature: string }
  | { readonly kind: "nexus"; readonly token: string };

// ---------------------------------------------------------------------------
// Branded delegation ID
// ---------------------------------------------------------------------------

declare const __delegationBrand: unique symbol;

/**
 * Branded string type for delegation grant identifiers.
 * Prevents accidental mixing with other string IDs at compile time.
 */
export type DelegationId = string & { readonly [__delegationBrand]: "DelegationId" };

/** Create a branded DelegationId from a plain string. */
export function delegationId(raw: string): DelegationId {
  return raw as DelegationId;
}

// ---------------------------------------------------------------------------
// Delegation scope (wraps PermissionConfig — DRY)
// ---------------------------------------------------------------------------

/**
 * What is being delegated. Wraps the existing PermissionConfig to stay DRY
 * and adds optional resource patterns.
 */
export interface DelegationScope {
  readonly permissions: PermissionConfig;
  /** Optional glob-style resource patterns (e.g., "read_file:/workspace/src/**"). */
  readonly resources?: readonly string[];
  /** Session that owns this grant — enables session-scoped revocation. */
  readonly sessionId?: string;
}

// ---------------------------------------------------------------------------
// Delegation grant (immutable token)
// ---------------------------------------------------------------------------

/**
 * An immutable delegation token linking an issuer to a delegatee with
 * scoped permissions, chain tracking, and HMAC signature.
 */
export interface DelegationGrant {
  readonly id: DelegationId;
  /** Agent ID of the delegator. */
  readonly issuerId: AgentId;
  /** Agent ID of the receiver. */
  readonly delegateeId: AgentId;
  /** What is being delegated. */
  readonly scope: DelegationScope;
  /** Chain link to parent delegation (undefined = root grant). */
  readonly parentId?: DelegationId;
  /** Depth in the delegation chain (0 = root). */
  readonly chainDepth: number;
  /** Maximum allowed re-delegation depth. */
  readonly maxChainDepth: number;
  /** Unix timestamp ms — when the grant was created. */
  readonly createdAt: number;
  /** Unix timestamp ms — when the grant expires. */
  readonly expiresAt: number;
  /**
   * Cryptographic proof binding this grant to its issuer.
   * Replaces the previous opaque `signature: string` field.
   * Use `kind: "hmac-sha256"` for root→engine internal grants;
   * use `kind: "ed25519"` for agent-to-agent delegation chains.
   */
  readonly proof: CapabilityProof;
}

// ---------------------------------------------------------------------------
// Verification result
// ---------------------------------------------------------------------------

/** Why a delegation was denied. */
export type DelegationDenyReason =
  | "expired"
  | "revoked"
  | "scope_exceeded"
  | "chain_depth_exceeded"
  | "invalid_signature"
  | "unknown_grant"
  | "session_expired"
  | "escalation_denied";

/** Result of verifying a delegation grant against a tool call. */
export type DelegationVerifyResult =
  | { readonly ok: true; readonly grant: DelegationGrant }
  | { readonly ok: false; readonly reason: DelegationDenyReason };

// ---------------------------------------------------------------------------
// Scope checker (pluggable permission engine)
// ---------------------------------------------------------------------------

/**
 * Pluggable scope resolution. Default implementation uses glob-style matching (L2).
 * Swap in ReBAC, policy engines, or external services (e.g., Nexus) as needed.
 *
 * Returns boolean for sync checkers (local glob matching) or Promise<boolean>
 * for async checkers (HTTP-based services like Nexus ReBAC).
 */
export interface ScopeChecker {
  readonly isAllowed: (toolId: string, scope: DelegationScope) => boolean | Promise<boolean>;
}

// ---------------------------------------------------------------------------
// Revocation registry (pluggable backend)
// ---------------------------------------------------------------------------

/** Pluggable revocation store. Default implementation is in-memory (L2). */
export interface RevocationRegistry {
  readonly isRevoked: (id: DelegationId) => boolean | Promise<boolean>;
  /**
   * Batch revocation check. Optional — when present, used by chain-verifier
   * to avoid N+1 async lookups when traversing delegation chains.
   *
   * Returns a map from DelegationId → revoked (true = revoked).
   * IDs not present in the map are assumed not revoked.
   */
  readonly isRevokedBatch?: (
    ids: readonly DelegationId[],
  ) => ReadonlyMap<DelegationId, boolean> | Promise<ReadonlyMap<DelegationId, boolean>>;
  readonly revoke: (id: DelegationId, cascade: boolean) => void | Promise<void>;
}

// ---------------------------------------------------------------------------
// Delegation config (manifest integration)
// ---------------------------------------------------------------------------

/** Configuration for the delegation subsystem, embedded in AgentManifest. */
export interface DelegationConfig {
  readonly enabled: boolean;
  /** Maximum chain depth for re-delegation (default: 3). */
  readonly maxChainDepth: number;
  /** Default grant TTL in milliseconds (default: 3600000 = 1 hour). */
  readonly defaultTtlMs: number;
}

// ---------------------------------------------------------------------------
// Delegation component (ECS singleton)
// ---------------------------------------------------------------------------

/** ECS component interface for delegation operations on an agent. */
export interface DelegationComponent {
  readonly grant: (
    scope: DelegationScope,
    delegateeId: AgentId,
    ttlMs?: number,
  ) => Promise<DelegationGrant>;
  readonly revoke: (id: DelegationId, cascade?: boolean) => Promise<void>;
  readonly verify: (id: DelegationId, toolId: string) => Promise<DelegationVerifyResult>;
  readonly list: () => Promise<readonly DelegationGrant[]>;
}

// ---------------------------------------------------------------------------
// Delegation events (DelegationManager lifecycle)
// ---------------------------------------------------------------------------

/**
 * Events emitted by DelegationManager during grant lifecycle operations.
 * Follows the RegistryEvent / SchedulerEvent discriminated union pattern.
 */
export type DelegationEvent =
  | { readonly kind: "delegation:granted"; readonly grant: DelegationGrant }
  | {
      readonly kind: "delegation:revoked";
      readonly grantId: DelegationId;
      readonly cascade: boolean;
      readonly revokedIds: readonly DelegationId[];
    }
  | { readonly kind: "delegation:expired"; readonly grantId: DelegationId }
  | {
      readonly kind: "delegation:denied";
      readonly grantId: DelegationId;
      readonly toolId: string;
      readonly reason: DelegationDenyReason;
    }
  | {
      readonly kind: "delegation:circuit_opened";
      readonly delegateeId: AgentId;
      readonly failureCount: number;
    }
  | { readonly kind: "delegation:circuit_closed"; readonly delegateeId: AgentId }
  | {
      readonly kind: "delegation:exhausted";
      readonly delegateeIds: readonly AgentId[];
      readonly issuerId: AgentId;
      readonly detectedAt: number;
    };

// ---------------------------------------------------------------------------
// Circuit breaker configuration
// ---------------------------------------------------------------------------

/** Configuration for per-delegatee circuit breaker in DelegationManager. */
export interface CircuitBreakerConfig {
  readonly failureThreshold: number;
  readonly resetTimeoutMs: number;
  readonly halfOpenMaxProbes: number;
}

/** Default circuit breaker settings. */
export const DEFAULT_CIRCUIT_BREAKER_CONFIG: CircuitBreakerConfig = Object.freeze({
  failureThreshold: 5,
  resetTimeoutMs: 30_000,
  halfOpenMaxProbes: 1,
});

// ---------------------------------------------------------------------------
// DelegationManager configuration
// ---------------------------------------------------------------------------

/** Full configuration for the DelegationManager coordinator. */
export interface DelegationManagerConfig {
  readonly secret: string;
  readonly maxChainDepth: number;
  readonly defaultTtlMs: number;
  readonly circuitBreaker: CircuitBreakerConfig;
}
