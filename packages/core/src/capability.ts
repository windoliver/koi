/**
 * Capability token types — unforgeable bearer tokens granting specific rights.
 *
 * Layer 3 of Koi's security model: capability = unforgeable token granting
 * specific rights, replacing permission = (subject, action, resource) checked
 * per call.
 *
 * Design decisions:
 * - CapabilityProof: discriminated union replacing opaque `signature: string`
 * - CapabilityToken: superset of DelegationGrant — wraps it as one proof kind
 * - Hybrid HMAC/Ed25519: HMAC for root→engine internal; Ed25519 for agent-to-agent
 * - Session-scoped revocation: tokens carry sessionId; parent death = all child tokens invalid
 * - requiresPoP: field reserved for v2 Proof-of-Possession; not enforced in v1
 *
 * All types are immutable (readonly). No runtime code except:
 * - branded type constructor for CapabilityId
 * - type guard isCapabilityToken
 */

import type { PermissionConfig } from "./assembly.js";
import type { CapabilityProof, DelegationDenyReason } from "./delegation.js";
import type { AgentId, SessionId } from "./ecs.js";

// ---------------------------------------------------------------------------
// Branded capability ID
// ---------------------------------------------------------------------------

declare const __capabilityBrand: unique symbol;

/**
 * Branded string type for capability token identifiers.
 * Prevents accidental mixing with DelegationId or other string IDs at compile time.
 */
export type CapabilityId = string & { readonly [__capabilityBrand]: "CapabilityId" };

/** Create a branded CapabilityId from a plain string. */
export function capabilityId(raw: string): CapabilityId {
  return raw as CapabilityId;
}

// CapabilityProof is defined in delegation.ts to avoid a circular dependency
// (capability.ts → delegation.ts is one-way). It is re-exported here for
// consumers who import all capability types from this module.
export type { CapabilityProof } from "./delegation.js";

// ---------------------------------------------------------------------------
// Capability scope
// ---------------------------------------------------------------------------

/**
 * What is being granted. Extends DelegationScope with session binding for
 * session-scoped revocation: when the issuer's session terminates, all tokens
 * bearing that sessionId become invalid.
 */
export interface CapabilityScope {
  /** The permission set granted to the delegatee. */
  readonly permissions: PermissionConfig;
  /** Optional glob-style resource patterns (e.g., "read_file:/workspace/src/**"). */
  readonly resources?: readonly string[];
  /**
   * Session the token is bound to. When this session is terminated,
   * all tokens with this sessionId are implicitly revoked.
   */
  readonly sessionId: SessionId;
}

// ---------------------------------------------------------------------------
// Capability token — the bearer authority type
// ---------------------------------------------------------------------------

/**
 * An immutable capability token representing bearer authority.
 *
 * A CapabilityToken is the superset of DelegationGrant: the `proof` field
 * is a discriminated union supporting HMAC, Ed25519, and Nexus proofs.
 *
 * Invariants:
 * - chainDepth <= maxChainDepth (enforced at grant time)
 * - scope must be a strict subset of parent's scope (monotonic attenuation)
 * - expiresAt > createdAt
 * - expiresAt <= parent.expiresAt (TTL cannot exceed parent's TTL)
 */
export interface CapabilityToken {
  /** Unique identifier for this token. */
  readonly id: CapabilityId;
  /** Agent that issued this token. */
  readonly issuerId: AgentId;
  /** Agent that received (holds) this token. */
  readonly delegateeId: AgentId;
  /** What is being granted, including session binding. */
  readonly scope: CapabilityScope;
  /** Parent token ID — undefined for root (engine-issued) tokens. */
  readonly parentId?: CapabilityId;
  /** Depth in the delegation chain (0 = root, issued by engine). */
  readonly chainDepth: number;
  /** Maximum allowed re-delegation depth from this token. */
  readonly maxChainDepth: number;
  /** Unix timestamp ms — when this token was created. */
  readonly createdAt: number;
  /** Unix timestamp ms — when this token expires. */
  readonly expiresAt: number;
  /** Cryptographic proof binding this token to its issuer. */
  readonly proof: CapabilityProof;
  /**
   * Reserved for v2 Proof-of-Possession (PoP) challenge/response.
   * When true, the verifier must challenge the holder before granting access.
   * Not enforced in v1 — field exists to allow forward-compatible token storage.
   */
  readonly requiresPoP?: boolean;
}

// ---------------------------------------------------------------------------
// Verify context
// ---------------------------------------------------------------------------

/**
 * Inputs available at verification time.
 * Passed to CapabilityVerifier.verify alongside the token.
 */
export interface VerifyContext {
  /** The tool being invoked — used for scope checking. */
  readonly toolId: string;
  /** Current Unix timestamp ms — used for expiry checking. */
  readonly now: number;
  /**
   * Set of currently active session IDs.
   * A token whose scope.sessionId is NOT in this set is revoked (session terminated).
   */
  readonly activeSessionIds: ReadonlySet<SessionId>;
}

// ---------------------------------------------------------------------------
// Capability deny reasons and verify result
// ---------------------------------------------------------------------------

/**
 * Why a capability token was denied.
 *
 * Extends DelegationDenyReason with capability-specific reasons:
 * - `session_invalid`: The token's sessionId is not in the active session set.
 * - `proof_type_unsupported`: The proof.kind is not handled by this verifier.
 */
export type CapabilityDenyReason =
  | DelegationDenyReason
  | "session_invalid"
  | "proof_type_unsupported";

/** Result of verifying a capability token against a tool call and context. */
export type CapabilityVerifyResult =
  | { readonly ok: true; readonly token: CapabilityToken }
  | { readonly ok: false; readonly reason: CapabilityDenyReason };

// ---------------------------------------------------------------------------
// Verifier cache (optional)
// ---------------------------------------------------------------------------

/**
 * Optional verification result cache for CapabilityVerifier.
 *
 * Implementors may use any eviction strategy (LRU, TTL-based, etc.).
 * The `evict` method MUST be called on revocation to prevent stale positives.
 *
 * The cache key is (tokenId, toolId) — both dimensions needed because the same
 * token may be allowed for one tool but denied for another (scope mismatch).
 */
export interface VerifierCache {
  /** Look up a cached result for the given token+tool pair. */
  readonly get: (tokenId: CapabilityId, toolId: string) => CapabilityVerifyResult | undefined;
  /** Store a result for the given token+tool pair. */
  readonly set: (tokenId: CapabilityId, toolId: string, result: CapabilityVerifyResult) => void;
  /** Evict all cached entries for a token (called on revocation). */
  readonly evict: (tokenId: CapabilityId) => void;
}

// ---------------------------------------------------------------------------
// CapabilityVerifier — L0 contract
// ---------------------------------------------------------------------------

/**
 * L0 contract for verifying capability tokens.
 *
 * Implementations:
 * - `@koi/capability-verifier`: HMAC + Ed25519 composite verifier (L2)
 *
 * The `verify` method returns synchronously for in-memory implementations
 * and asynchronously for remote/Nexus-backed implementations. Callers must
 * always `await` the result.
 */
export interface CapabilityVerifier {
  /**
   * Verify a capability token against the given context.
   *
   * @param token - The bearer token to verify.
   * @param context - Current tool ID, timestamp, and active session set.
   * @returns CapabilityVerifyResult — ok=true if all checks pass, ok=false with reason otherwise.
   */
  readonly verify: (
    token: CapabilityToken,
    context: VerifyContext,
  ) => CapabilityVerifyResult | Promise<CapabilityVerifyResult>;
  /**
   * Optional verification result cache.
   * When provided, the verifier should consult the cache before computing.
   * The cache evict() MUST be called on revocation.
   */
  readonly cache?: VerifierCache | undefined;
  /**
   * Optional cleanup hook. Called when the verifier is no longer needed.
   * Implementations should release any held resources (timers, connections).
   */
  readonly dispose?: () => void | Promise<void>;
}

// ---------------------------------------------------------------------------
// Type guard
// ---------------------------------------------------------------------------

/**
 * Type guard for CapabilityToken.
 * Pure function — permitted in L0 as a side-effect-free data inspector.
 */
export function isCapabilityToken(value: unknown): value is CapabilityToken {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === "string" &&
    typeof v.issuerId === "string" &&
    typeof v.delegateeId === "string" &&
    typeof v.scope === "object" &&
    v.scope !== null &&
    typeof v.chainDepth === "number" &&
    typeof v.maxChainDepth === "number" &&
    typeof v.createdAt === "number" &&
    typeof v.expiresAt === "number" &&
    typeof v.proof === "object" &&
    v.proof !== null
  );
}
