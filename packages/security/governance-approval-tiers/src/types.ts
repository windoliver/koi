import type { JsonObject } from "@koi/core";
import type { PolicyRequestKind } from "@koi/core/governance-backend";

/** Narrow union of the three user-facing approval tiers. */
export type ApprovalScope = "once" | "session" | "always";

/** A single persisted approval record. Append-only. */
export interface PersistedApproval {
  readonly kind: PolicyRequestKind;
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

/** Query shape for ApprovalStore.match(). */
export interface ApprovalQuery {
  readonly kind: PolicyRequestKind;
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
