import type { AgentId, JsonObject } from "@koi/core";
import type { PolicyRequestKind } from "@koi/core/governance-backend";

/** Narrow union of the three user-facing approval tiers. */
export type ApprovalScope = "once" | "session" | "always";

/**
 * A single persisted approval record. Append-only.
 *
 * `agentId` is the actor scope: a grant recorded for one agent must
 * never satisfy a query from a different agent, even when (kind, payload)
 * are identical. This is the actor-scope guard; without it, a backend
 * whose ask decision depends on the requesting agent could replay a
 * lower-trust agent's approval as `GOVERNANCE_ALLOW` for a higher-trust
 * one.
 */
export interface PersistedApproval {
  readonly kind: PolicyRequestKind;
  readonly agentId: AgentId;
  readonly payload: JsonObject;
  /** Stable SHA-256 hex of (kind, payload) via @koi/hash.computeGrantKey. */
  readonly grantKey: string;
  /** Unix timestamp (ms) when the grant was recorded. */
  readonly grantedAt: number;
  /**
   * Optional: the grantKey this record supersedes when the grant was
   * migrated via an AliasSpec. Preserves a history trail without
   * mutating previously-written lines.
   */
  readonly aliasOf?: string;
}

/**
 * Query shape for ApprovalStore.match().
 *
 * `agentId` is required — the store must enforce actor-scope equality,
 * not just (kind, payload) match.
 */
export interface ApprovalQuery {
  readonly kind: PolicyRequestKind;
  readonly agentId: AgentId;
  readonly payload: JsonObject;
}

/**
 * Renames a single payload field so that approvals granted under an
 * old value still match new queries carrying the new value. Applied
 * identically on append (canonicalises new grants to the target value)
 * and on match (rewrites the query before computing grantKey).
 */
export interface AliasSpec {
  readonly kind: PolicyRequestKind;
  readonly field: string;
  readonly from: string;
  readonly to: string;
}

/** Persistent approval allowlist. All methods are async. */
export interface ApprovalStore {
  readonly append: (g: PersistedApproval) => Promise<void>;
  readonly match: (q: ApprovalQuery) => Promise<PersistedApproval | undefined>;
  readonly load: () => Promise<readonly PersistedApproval[]>;
}
