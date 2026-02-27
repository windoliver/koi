/**
 * Governance backend — pluggable rule-based policy evaluation contract (Layer 0).
 *
 * Defines the shapes for evaluating policy requests, checking constraints,
 * recording compliance, and querying violation history. L2 packages implement
 * GovernanceBackend for specific backends (OPA, Cedar, in-memory rule engine, etc.).
 *
 * Complementary to GovernanceController (governance.ts) which handles numeric
 * sensor/setpoint governance (turns, tokens, spawn depth). GovernanceBackend
 * handles rule-based policy evaluation, constraint checking, compliance recording,
 * and violation tracking. Both are composed by the unified governance controller (#261).
 *
 * Relationship to ScopeEnforcer (scope-enforcement.ts): ScopeEnforcer handles
 * subsystem access checks (filesystem, browser, credentials, memory) with a
 * boolean allow/deny result. GovernanceBackend handles broader policy evaluation
 * with rich verdicts, violation details, and compliance recording. They are
 * independent contracts — ScopeEnforcer is not subsumed.
 *
 * Fail-closed contract: callers MUST deny access when evaluate() throws or
 * returns an error. A missing or errored backend means "deny all".
 *
 * Exception: constants (VIOLATION_SEVERITY_ORDER, GOVERNANCE_ALLOW,
 * DEFAULT_VIOLATION_QUERY_LIMIT) are pure readonly data derived from L0 type
 * definitions, permitted in L0 per architecture rules.
 */

import type { JsonObject } from "./common.js";
import type { AgentId, SessionId } from "./ecs.js";

// ---------------------------------------------------------------------------
// PolicyRequestKind — what kind of action is being evaluated
// ---------------------------------------------------------------------------

/**
 * Categorical kind for policy evaluation requests.
 * Covers the core agent lifecycle actions. Use `custom:${string}` for
 * domain-specific extensions without modifying the core union.
 */
export type PolicyRequestKind =
  | "tool_call"
  | "model_call"
  | "spawn"
  | "delegation"
  | "forge"
  | "handoff"
  | `custom:${string}`;

// ---------------------------------------------------------------------------
// PolicyRequest — the input to policy evaluation
// ---------------------------------------------------------------------------

/**
 * A request to evaluate against governance policy.
 * Follows the PEP-PDP (Policy Enforcement Point / Policy Decision Point) pattern:
 * the caller (PEP) constructs a PolicyRequest, the backend (PDP) returns a verdict.
 */
export interface PolicyRequest {
  /** The kind of action being evaluated. */
  readonly kind: PolicyRequestKind;
  /** The agent requesting the action. */
  readonly agentId: AgentId;
  /** Action-specific payload for policy evaluation. */
  readonly payload: JsonObject;
  /** Unix timestamp (ms) when the request was created. */
  readonly timestamp: number;
}

// ---------------------------------------------------------------------------
// ViolationSeverity — how serious a policy violation is
// ---------------------------------------------------------------------------

/**
 * Severity level for policy violations.
 * Ordered from least to most severe — see VIOLATION_SEVERITY_ORDER for
 * the canonical sequence.
 */
export type ViolationSeverity = "info" | "warning" | "critical";

/**
 * Canonical ordering of ViolationSeverity values from least to most severe.
 * Use this to avoid hardcoding the sequence in consumers:
 *
 * ```typescript
 * const idx = VIOLATION_SEVERITY_ORDER.indexOf(violation.severity);
 * if (idx >= VIOLATION_SEVERITY_ORDER.indexOf("warning")) { ... }
 * ```
 */
export const VIOLATION_SEVERITY_ORDER: readonly ViolationSeverity[] = Object.freeze([
  "info",
  "warning",
  "critical",
] as const);

// ---------------------------------------------------------------------------
// Violation — a single policy rule violation
// ---------------------------------------------------------------------------

/** A single policy rule violation found during evaluation. */
export interface Violation {
  /** The rule identifier that was violated (e.g., "max-spawn-depth", "no-external-api"). */
  readonly rule: string;
  /** How severe this violation is. */
  readonly severity: ViolationSeverity;
  /** Human-readable description of the violation. */
  readonly message: string;
  /** Optional structured context for diagnostics. */
  readonly context?: JsonObject | undefined;
}

// ---------------------------------------------------------------------------
// GovernanceVerdict — the output of policy evaluation
// ---------------------------------------------------------------------------

/**
 * Result of evaluating a PolicyRequest against governance rules.
 * Discriminated union on `ok`:
 * - `ok: true` — request is allowed, with optional diagnostics (info-level observations)
 * - `ok: false` — request is denied, with one or more violations
 */
export type GovernanceVerdict =
  | {
      readonly ok: true;
      /** Optional info-level observations (e.g., "approaching rate limit"). */
      readonly diagnostics?: readonly Violation[] | undefined;
    }
  | {
      readonly ok: false;
      /** One or more violations that caused denial. Never empty when ok is false. */
      readonly violations: readonly Violation[];
    };

/**
 * Singleton allow verdict for the common case.
 * Avoids allocating a new object on every allow decision.
 * Frozen to prevent accidental mutation.
 */
export const GOVERNANCE_ALLOW: GovernanceVerdict = Object.freeze({
  ok: true as const,
});

// ---------------------------------------------------------------------------
// ConstraintQuery — input to constraint checking
// ---------------------------------------------------------------------------

/**
 * Minimal query for checking a single constraint.
 * Used by ConstraintChecker to evaluate numeric or boolean constraints
 * (e.g., "can this agent spawn at depth 4?").
 */
export interface ConstraintQuery {
  /** The constraint kind to check (e.g., "spawn_depth", "token_budget"). */
  readonly kind: string;
  /** The agent the constraint applies to. */
  readonly agentId: AgentId;
  /** Optional numeric or string value to check against the constraint limit. */
  readonly value?: number | string | undefined;
  /** Optional structured context for the check. */
  readonly context?: JsonObject | undefined;
}

// ---------------------------------------------------------------------------
// ComplianceRecord — lightweight attestation for audit trails
// ---------------------------------------------------------------------------

/** A recorded compliance event linking a request to its verdict. */
export interface ComplianceRecord {
  /** Unique identifier for this compliance record. */
  readonly requestId: string;
  /** The original policy request that was evaluated. */
  readonly request: PolicyRequest;
  /** The verdict returned by the evaluator. */
  readonly verdict: GovernanceVerdict;
  /** Unix timestamp (ms) when the evaluation occurred. */
  readonly evaluatedAt: number;
  /** Fingerprint of the policy version used for evaluation (for reproducibility). */
  readonly policyFingerprint: string;
}

// ---------------------------------------------------------------------------
// ViolationFilter + ViolationPage — querying violation history
// ---------------------------------------------------------------------------

/**
 * Default maximum number of violation entries returned by a single getViolations() call.
 * Implementations SHOULD apply this when the caller omits `limit`.
 */
export const DEFAULT_VIOLATION_QUERY_LIMIT: 100 = 100;

/**
 * Filter for querying recorded violations.
 * All fields are optional — omitting a field means "no constraint on that dimension".
 */
export interface ViolationFilter {
  /** Filter to violations for this agent. */
  readonly agentId?: AgentId | undefined;
  /** Filter to violations within this session. */
  readonly sessionId?: SessionId | undefined;
  /** Filter to violations at or above this severity. */
  readonly severity?: ViolationSeverity | undefined;
  /** Filter to violations matching this rule identifier. */
  readonly rule?: string | undefined;
  /** Include only violations at or after this Unix timestamp (ms). */
  readonly since?: number | undefined;
  /** Include only violations before this Unix timestamp (ms). */
  readonly until?: number | undefined;
  /** Maximum number of entries to return. Defaults to DEFAULT_VIOLATION_QUERY_LIMIT. */
  readonly limit?: number | undefined;
  /** Opaque cursor for pagination (from a previous ViolationPage.cursor). */
  readonly offset?: string | undefined;
}

/** Paginated result of a violation query. */
export interface ViolationPage {
  /** Violation entries matching the filter. */
  readonly items: readonly Violation[];
  /** Opaque cursor for fetching the next page. Absent when no more pages. */
  readonly cursor?: string | undefined;
  /** Total count of matching violations (if the backend supports it). */
  readonly total?: number | undefined;
}

// ---------------------------------------------------------------------------
// Sub-interfaces (ISP split)
// ---------------------------------------------------------------------------

/**
 * Evaluates policy requests and returns verdicts.
 *
 * The `scope` field is a hot-path optimization: when present, the engine
 * can skip invoking this evaluator for request kinds not in the scope set.
 * When absent, the evaluator is invoked for all request kinds.
 */
export interface PolicyEvaluator {
  /** Evaluate a policy request. Returns a verdict (allow/deny with details). */
  readonly evaluate: (request: PolicyRequest) => GovernanceVerdict | Promise<GovernanceVerdict>;
  /**
   * Optional declarative scope filter. When present, this evaluator is only
   * invoked for request kinds matching one of these values. When absent,
   * the evaluator handles all request kinds.
   */
  readonly scope?: readonly PolicyRequestKind[] | undefined;
}

/** Checks individual constraints (numeric/boolean limit checks). */
export interface ConstraintChecker {
  /** Check whether a constraint is satisfied. Returns true if the constraint passes. */
  readonly checkConstraint: (query: ConstraintQuery) => boolean | Promise<boolean>;
}

/** Records compliance events for audit trails. */
export interface ComplianceRecorder {
  /** Record a compliance event. Returns the recorded entry. */
  readonly recordCompliance: (
    record: ComplianceRecord,
  ) => ComplianceRecord | Promise<ComplianceRecord>;
}

/** Queries recorded violation history. */
export interface ViolationStore {
  /** Query recorded violations matching the filter. */
  readonly getViolations: (filter: ViolationFilter) => ViolationPage | Promise<ViolationPage>;
}

// ---------------------------------------------------------------------------
// GovernanceBackend — composite interface
// ---------------------------------------------------------------------------

/**
 * Pluggable governance backend for rule-based policy evaluation.
 *
 * Composed of ISP-split sub-interfaces:
 * - `evaluator` (required) — the core policy evaluation engine
 * - `constraints` (optional) — individual constraint checks
 * - `compliance` (optional) — compliance recording for audit
 * - `violations` (optional) — violation history queries
 *
 * Fail-closed: if `evaluator.evaluate()` throws, callers MUST deny.
 * Optional sub-interfaces degrade gracefully — constraint checks return
 * true (allow) when no ConstraintChecker is configured, etc.
 */
export interface GovernanceBackend {
  /** The policy evaluator (required). */
  readonly evaluator: PolicyEvaluator;
  /** Optional constraint checker for individual limit checks. */
  readonly constraints?: ConstraintChecker | undefined;
  /** Optional compliance recorder for audit trails. */
  readonly compliance?: ComplianceRecorder | undefined;
  /** Optional violation store for querying violation history. */
  readonly violations?: ViolationStore | undefined;
  /** Optional cleanup for stateful backends (connection pools, timers). */
  readonly dispose?: () => void | Promise<void>;
}
