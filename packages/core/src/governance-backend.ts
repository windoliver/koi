/**
 * GovernanceBackend — pluggable anomaly detection and constraint enforcement contract (Layer 0).
 *
 * Defines the interface for evaluating governance events against policy rules,
 * checking constraints, recording compliance attestations, and querying violations.
 *
 * L2 packages implement GovernanceBackend for specific backends:
 *   - @koi/governance: local in-process rule evaluation (default)
 *   - @koi/governance-nexus: Nexus governance brick (attestation, audit, compliance)
 *   - User-provided: any implementation of GovernanceBackend
 *
 * Consumed by: agent-monitor (#59), spawn governance, ProposalGate (#223),
 *              unified governance controller (#261).
 *
 * Fail-closed contract: if evaluate() or checkConstraint() throw, callers
 * MUST deny the operation. Infrastructure failures are not distinguished from
 * intentional denials — never treat a throwing backend as permissive.
 *
 * Exception: governanceAttestationId() is a branded type constructor (identity cast),
 * permitted in L0 as a zero-logic operation for type safety.
 *
 * Exception: DEFAULT_VIOLATION_QUERY_LIMIT and VIOLATION_SEVERITIES are pure readonly
 * data constants derived from L0 type definitions, codifying architecture-doc
 * invariants with zero logic.
 */

import type { JsonObject } from "./common.js";
import type { AgentId } from "./ecs.js";
import type { KoiError, Result } from "./errors.js";

// ---------------------------------------------------------------------------
// GovernanceBackendEvent — input event for policy evaluation
// ---------------------------------------------------------------------------

/**
 * An event submitted to the governance backend for policy evaluation.
 *
 * Distinct from GovernanceEvent (governance.ts), which is the controller's
 * sensor-update event (a closed discriminated union for the sensor/setpoint model).
 * GovernanceBackendEvent uses an open string kind with an arbitrary payload,
 * supporting any event the backend needs to evaluate — including custom event kinds
 * from L2 packages.
 */
export interface GovernanceBackendEvent {
  /**
   * Semantic event type. Well-known kinds: "tool_call" | "spawn" | "forge" |
   * "promotion" | "proposal". Backends may support additional kinds.
   */
  readonly kind: string;
  /** The agent that produced this event. */
  readonly agentId: AgentId;
  /** Structured event payload — backend-specific content for rule evaluation. */
  readonly payload: JsonObject;
  /** Unix timestamp (ms) when the event occurred. */
  readonly timestamp: number;
}

// ---------------------------------------------------------------------------
// ViolationSeverity — categorical severity for policy violations
// ---------------------------------------------------------------------------

/**
 * Severity level for a policy violation. Ordered from lowest to highest impact.
 * Use VIOLATION_SEVERITIES for the canonical ordering and comparison.
 */
export type ViolationSeverity = "info" | "warning" | "critical";

/**
 * Canonical ordering of ViolationSeverity values from lowest to highest impact.
 * Use for severity comparison:
 *
 * ```typescript
 * const infoIdx    = VIOLATION_SEVERITIES.indexOf("info");    // 0
 * const warningIdx = VIOLATION_SEVERITIES.indexOf("warning"); // 1
 * const critIdx    = VIOLATION_SEVERITIES.indexOf("critical"); // 2
 * if (VIOLATION_SEVERITIES.indexOf(v.severity) >= VIOLATION_SEVERITIES.indexOf("warning")) { ... }
 * ```
 */
export const VIOLATION_SEVERITIES: readonly ViolationSeverity[] = Object.freeze([
  "info",
  "warning",
  "critical",
] as const);

// ---------------------------------------------------------------------------
// Violation — a single policy rule violation
// ---------------------------------------------------------------------------

/**
 * A single policy rule violation produced by a GovernanceBackend.evaluate() call.
 *
 * A GovernanceVerdict may contain multiple Violations — one per violated rule.
 * Backends SHOULD include all violated rules (not just the first) to enable
 * consumers to make fully informed decisions.
 */
export interface Violation {
  /** The rule identifier that was violated (backend-defined). */
  readonly rule: string;
  /** Categorical impact level of this violation. */
  readonly severity: ViolationSeverity;
  /** Human-readable description of the violation. Answers: what happened + why. */
  readonly message: string;
  /** Optional structured context for this violation (threshold values, agent state, etc.). */
  readonly context?: JsonObject | undefined;
}

// ---------------------------------------------------------------------------
// GovernanceVerdict — result of a policy evaluation
// ---------------------------------------------------------------------------

/**
 * The outcome of a GovernanceBackend.evaluate() call.
 *
 * Distinct from GovernanceCheck (governance.ts), which is the controller's
 * per-sensor check result ("did this one variable exceed its limit?", single
 * variable, retryable flag). GovernanceVerdict is the backend's policy evaluation
 * result: zero or more violations across all applicable rules for a single event.
 */
export type GovernanceVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly violations: readonly Violation[] };

// ---------------------------------------------------------------------------
// ConstraintQuery — input for a specific constraint check
// ---------------------------------------------------------------------------

/**
 * Input for a point-in-time constraint check against a specific agent.
 * The constraint is identified by ID; the backend resolves the rule definition.
 */
export interface ConstraintQuery {
  /** The constraint identifier to check (backend-defined rule ID). */
  readonly constraintId: string;
  /** The agent to check the constraint against. */
  readonly agentId: AgentId;
  /** Optional structured context for evaluating the constraint. */
  readonly context?: JsonObject | undefined;
}

// ---------------------------------------------------------------------------
// ViolationQuery — filter for querying stored violation records
// ---------------------------------------------------------------------------

/**
 * Default maximum number of violations returned by a single getViolations() call.
 * Implementations SHOULD apply this when the caller omits `limit`.
 */
export const DEFAULT_VIOLATION_QUERY_LIMIT = 100;

/**
 * Filter for querying stored violation records.
 * All fields are optional — omitting a field means "no constraint on that dimension".
 * Providing no fields returns ALL violations up to `limit` — use with care.
 */
export interface ViolationQuery {
  /** Filter to violations for a specific agent. */
  readonly agentId?: AgentId | undefined;
  /** Filter to violations matching any of these severity levels. */
  readonly severity?: readonly ViolationSeverity[] | undefined;
  /** Filter to violations from a specific rule. */
  readonly ruleId?: string | undefined;
  /** Include only violations at or after this Unix timestamp (ms). */
  readonly after?: number | undefined;
  /** Include only violations before this Unix timestamp (ms). */
  readonly before?: number | undefined;
  /**
   * Maximum number of violations to return.
   * Defaults to DEFAULT_VIOLATION_QUERY_LIMIT when omitted.
   */
  readonly limit?: number | undefined;
}

// ---------------------------------------------------------------------------
// GovernanceAttestation — compliance claim recorded by the backend
// ---------------------------------------------------------------------------

declare const __governanceAttestationBrand: unique symbol;

/**
 * Branded string type for governance attestation identifiers.
 * Prevents accidental mixing with other string IDs (ProposalId, BrickId, etc.)
 * at compile time.
 */
export type GovernanceAttestationId = string & {
  readonly [__governanceAttestationBrand]: "GovernanceAttestationId";
};

/** Create a branded GovernanceAttestationId from a plain string. */
export function governanceAttestationId(raw: string): GovernanceAttestationId {
  return raw as GovernanceAttestationId;
}

/**
 * Data provided by the caller when recording a compliance attestation.
 * The backend assigns id, attestedAt, and attestedBy — callers provide
 * the agentId, ruleId, verdict, and optional evidence.
 */
export interface GovernanceAttestationInput {
  /** The agent this attestation is about. */
  readonly agentId: AgentId;
  /** The rule or policy this attestation covers (backend-defined rule ID). */
  readonly ruleId: string;
  /** The policy evaluation result being attested. */
  readonly verdict: GovernanceVerdict;
  /** Optional structured evidence supporting the attestation. */
  readonly evidence?: JsonObject | undefined;
}

/**
 * A governance compliance attestation as stored and returned by the backend.
 * Immutable — each attestation is a point-in-time compliance claim.
 * Callers receive this from recordAttestation(); it is never mutated.
 */
export interface GovernanceAttestation {
  /** Backend-assigned unique identifier for this attestation. */
  readonly id: GovernanceAttestationId;
  /** The agent this attestation is about. */
  readonly agentId: AgentId;
  /** The rule or policy this attestation covers. */
  readonly ruleId: string;
  /** The policy evaluation result being attested. */
  readonly verdict: GovernanceVerdict;
  /** Optional structured evidence supporting the attestation. */
  readonly evidence?: JsonObject | undefined;
  /** Unix timestamp (ms) when this attestation was recorded. Backend-assigned. */
  readonly attestedAt: number;
  /**
   * Identity of the backend that recorded this attestation.
   * Allows consumers to distinguish attestations from different backends
   * (e.g., "local", "nexus", "custom").
   */
  readonly attestedBy: string;
}

// ---------------------------------------------------------------------------
// GovernanceBackend — the main pluggable contract
// ---------------------------------------------------------------------------

/**
 * Pluggable anomaly detection and constraint enforcement backend.
 *
 * All methods return `T | Promise<T>` — in-memory implementations return sync
 * values, database/network implementations return Promises. Callers must always
 * `await` the result.
 *
 * **Fail-closed contract**: `evaluate()` and `checkConstraint()` do NOT use
 * `Result<T, KoiError>`. If they throw, callers MUST treat the operation as
 * denied. Infrastructure failures are indistinguishable from intentional denials
 * — never treat a throwing backend as permissive.
 *
 * `recordAttestation()` and `getViolations()` use `Result<T, KoiError>` because
 * their callers need structured error information (retry vs. permanent failure,
 * storage unavailable vs. invalid input).
 *
 * @see GovernanceController (governance.ts) — sensor/setpoint runtime model.
 * @see ProposalGate (proposal.ts) — structural layer change governance.
 * @see AuditSink (audit-backend.ts) — structured audit logging.
 */
export interface GovernanceBackend {
  /**
   * Evaluate a governance event against all applicable policy rules.
   *
   * Returns `{ ok: true }` if no rules are violated.
   * Returns `{ ok: false; violations }` if one or more rules are violated.
   * Backends SHOULD include all violated rules (not only the first).
   *
   * **Fail closed**: if this method throws, callers MUST deny the operation.
   * Never treat a throwing backend as permissive.
   */
  readonly evaluate: (
    event: GovernanceBackendEvent,
  ) => GovernanceVerdict | Promise<GovernanceVerdict>;

  /**
   * Check whether a specific constraint is satisfied for the given agent.
   *
   * Returns `true` if the constraint is satisfied.
   * Returns `false` if the constraint is violated.
   *
   * **Fail closed**: if this method throws, callers MUST deny the operation.
   * Never treat a throwing backend as permissive.
   */
  readonly checkConstraint: (constraint: ConstraintQuery) => boolean | Promise<boolean>;

  /**
   * Record a compliance attestation for a governance evaluation result.
   *
   * The backend assigns `id`, `attestedAt`, and `attestedBy`.
   * Returns the stored GovernanceAttestation on success.
   * Returns a KoiError on validation failure or storage error.
   *
   * Implementations SHOULD be idempotent for identical
   * (agentId, ruleId, verdict, timestamp) tuples to handle retry scenarios.
   */
  readonly recordAttestation: (
    input: GovernanceAttestationInput,
  ) => Result<GovernanceAttestation, KoiError> | Promise<Result<GovernanceAttestation, KoiError>>;

  /**
   * Query stored violation records matching the filter.
   *
   * Returns violations ordered by timestamp descending (most recent first).
   * Applies DEFAULT_VIOLATION_QUERY_LIMIT when `filter.limit` is omitted.
   * Check the returned array length against `filter.limit` to detect truncation.
   */
  readonly getViolations: (
    filter: ViolationQuery,
  ) => Result<readonly Violation[], KoiError> | Promise<Result<readonly Violation[], KoiError>>;

  /** Close the backend and release resources (connections, timers, file handles). */
  readonly dispose?: () => void | Promise<void>;
}
