/**
 * Proposal + ProposalGate — unified change governance contract.
 *
 * Every agent-submitted change request flows through this contract.
 * The gate requirement scales with the architectural blast radius of the target layer:
 *   brick:sandboxed  → auto (sandbox verifies), takes effect immediately
 *   brick:promoted   → HITL required, takes effect next session
 *   bundle_l2        → auto (forge store shadows it), takes effect immediately
 *   l1_extension     → HITL + full agent test, takes effect at next startup
 *   l1_core          → HITL + full agent test, requires new binary
 *   l0_interface     → HITL + all agents test, requires new binary
 *   sandbox_policy   → HITL + meta-sandbox, takes effect on config push
 *   gateway_routing  → HITL + staging gateway, takes effect on config push
 *
 * Exception: proposalId() is a branded type constructor (identity cast), permitted
 * in L0 as a zero-logic operation for type safety.
 *
 * Exception: ALL_CHANGE_TARGETS and PROPOSAL_GATE_REQUIREMENTS are pure readonly
 * data constants derived from L0 type definitions, codifying architecture-doc
 * invariants with zero logic.
 */

import type { BrickRef } from "./brick-snapshot.js";
import type { JsonObject } from "./common.js";
import type { AgentId } from "./ecs.js";
import type { KoiError, Result } from "./errors.js";

// ---------------------------------------------------------------------------
// Branded ProposalId
// ---------------------------------------------------------------------------

declare const __proposalBrand: unique symbol;

/**
 * Branded string type for proposal identifiers.
 * Prevents accidental mixing with other string IDs at compile time.
 */
export type ProposalId = string & { readonly [__proposalBrand]: "ProposalId" };

/** Create a branded ProposalId from a plain string. */
export function proposalId(raw: string): ProposalId {
  return raw as ProposalId;
}

// ---------------------------------------------------------------------------
// ChangeTarget — which architectural layer is being changed
// ---------------------------------------------------------------------------

/**
 * The architectural layer targeted by a proposal.
 * Names align with ToolPolicy vocabulary so submitters can reason about them:
 *   "brick:sandboxed" — tool or skill (ToolPolicy "sandbox", auto-verified)
 *   "brick:promoted"  — middleware or channel (ToolPolicy "promoted", HITL required)
 *
 * Maps 1:1 to the "Trust Gate by Layer" table in the architecture doc.
 */
export type ChangeTarget =
  | "brick:sandboxed" // tool, skill — ToolPolicy "sandbox", auto verified
  | "brick:promoted" // middleware, channel — ToolPolicy "promoted", HITL required
  | "bundle_l2" // fork to forge store, shadows bundled L2 — auto
  | "l1_extension" // HITL + full agent test, takes effect at next startup
  | "l1_core" // HITL + full agent test, requires new binary
  | "l0_interface" // HITL + all agents test, requires new binary
  | "sandbox_policy" // HITL + meta-sandbox test, config push
  | "gateway_routing"; // HITL + staging gateway test, config push

/** All valid ChangeTarget values. Used for exhaustiveness checks in tests and implementations. */
export const ALL_CHANGE_TARGETS: readonly ChangeTarget[] = [
  "brick:sandboxed",
  "brick:promoted",
  "bundle_l2",
  "l1_extension",
  "l1_core",
  "l0_interface",
  "sandbox_policy",
  "gateway_routing",
] as const;

// ---------------------------------------------------------------------------
// ChangeKind — what operation is being requested
// ---------------------------------------------------------------------------

/** The type of change being proposed. */
export type ChangeKind =
  | "create" // forging a new brick or adding a new capability
  | "update" // modifying an existing brick or configuration
  | "promote" // promoting scope: agent → zone → global
  | "delete" // removing a brick or capability
  | "configure" // changing governance or policy settings
  | "extend"; // extending an existing interface or system

// ---------------------------------------------------------------------------
// ProposalStatus — lifecycle states
// ---------------------------------------------------------------------------

/**
 * Lifecycle state of a proposal.
 * Terminal states: approved, rejected, superseded, expired.
 * Non-terminal: pending.
 */
export type ProposalStatus =
  | "pending" // submitted, awaiting review
  | "approved" // gate passed — change may proceed
  | "rejected" // gate denied — change blocked
  | "superseded" // replaced by a newer proposal (see supersededBy field)
  | "expired"; // expiresAt timestamp passed before review

// ---------------------------------------------------------------------------
// GateRequirement — what each ChangeTarget requires at the gate
// ---------------------------------------------------------------------------

/**
 * Gate requirements for a given ChangeTarget.
 * Encodes the "Trust Gate by Layer" table from the architecture doc.
 */
export interface GateRequirement {
  /** Whether a human must explicitly approve before the change proceeds. */
  readonly requiresHitl: boolean;
  /**
   * Whether the change requires a full test suite (full agent test or all agents test)
   * beyond the isolated brick verification.
   */
  readonly requiresFullTest: boolean;
  /** When the change takes effect after gate approval. */
  readonly takeEffectOn:
    | "immediately"
    | "next_session"
    | "next_startup"
    | "next_binary"
    | "config_push";
  /** Scope of sandbox testing required for this change. */
  readonly sandboxTestScope:
    | "brick_only"
    | "brick_plus_integration"
    | "full_agent_test"
    | "all_agents_test"
    | "meta_sandbox"
    | "staging_gateway";
}

// ---------------------------------------------------------------------------
// PROPOSAL_GATE_REQUIREMENTS — architecture-doc invariants as a data constant
// ---------------------------------------------------------------------------

/**
 * Gate requirements per ChangeTarget. Encodes the full "Trust Gate by Layer"
 * table from the architecture doc. Zero logic — pure lookup.
 *
 * Blast radius increases from top to bottom:
 *   brick:sandboxed  → lowest (affects this brick only, immediately)
 *   l0_interface     → highest (affects all agents, requires new binary)
 */
export const PROPOSAL_GATE_REQUIREMENTS: Readonly<Record<ChangeTarget, GateRequirement>> =
  Object.freeze({
    "brick:sandboxed": {
      requiresHitl: false,
      requiresFullTest: false,
      takeEffectOn: "immediately",
      sandboxTestScope: "brick_only",
    },
    "brick:promoted": {
      requiresHitl: true,
      requiresFullTest: false,
      takeEffectOn: "next_session",
      sandboxTestScope: "brick_plus_integration",
    },
    bundle_l2: {
      requiresHitl: false,
      requiresFullTest: false,
      takeEffectOn: "immediately",
      sandboxTestScope: "brick_only",
    },
    l1_extension: {
      requiresHitl: true,
      requiresFullTest: true,
      takeEffectOn: "next_startup",
      sandboxTestScope: "full_agent_test",
    },
    l1_core: {
      requiresHitl: true,
      requiresFullTest: true,
      takeEffectOn: "next_binary",
      sandboxTestScope: "full_agent_test",
    },
    l0_interface: {
      requiresHitl: true,
      requiresFullTest: true,
      takeEffectOn: "next_binary",
      sandboxTestScope: "all_agents_test",
    },
    sandbox_policy: {
      requiresHitl: true,
      requiresFullTest: false,
      takeEffectOn: "config_push",
      sandboxTestScope: "meta_sandbox",
    },
    gateway_routing: {
      requiresHitl: true,
      requiresFullTest: false,
      takeEffectOn: "config_push",
      sandboxTestScope: "staging_gateway",
    },
  }) satisfies Record<ChangeTarget, GateRequirement>;

// ---------------------------------------------------------------------------
// ReviewDecision — the gate's verdict on a proposal
// ---------------------------------------------------------------------------

/**
 * The outcome of a human (or automated) review of a proposal.
 * Distinct from ApprovalDecision (middleware.ts) which is per-tool-call.
 * Rejection always requires a reason; approval reason is optional.
 */
export type ReviewDecision =
  | { readonly kind: "approved"; readonly reason?: string | undefined }
  | { readonly kind: "rejected"; readonly reason: string };

// ---------------------------------------------------------------------------
// ProposalEvent — events emitted by ProposalGate
// ---------------------------------------------------------------------------

/**
 * Events emitted by ProposalGate during proposal lifecycle operations.
 * Follows the RegistryEvent / DelegationEvent discriminated union pattern.
 */
export type ProposalEvent =
  | { readonly kind: "proposal:submitted"; readonly proposal: Proposal }
  | {
      readonly kind: "proposal:reviewed";
      readonly proposalId: ProposalId;
      readonly decision: ReviewDecision;
    }
  | { readonly kind: "proposal:expired"; readonly proposalId: ProposalId }
  | {
      readonly kind: "proposal:superseded";
      readonly proposalId: ProposalId;
      readonly supersededBy: ProposalId;
    };

// ---------------------------------------------------------------------------
// ProposalInput — what the submitter provides
// ---------------------------------------------------------------------------

/**
 * Data provided by the agent when submitting a change proposal.
 * The gate assigns id, status, and submittedAt.
 */
export interface ProposalInput {
  /** Agent ID of the submitter. */
  readonly submittedBy: AgentId;
  /** Which architectural layer this change targets. */
  readonly changeTarget: ChangeTarget;
  /** What kind of operation is being requested. */
  readonly changeKind: ChangeKind;
  /** Human-readable description of what is being changed and why. */
  readonly description: string;
  /** Optional reference to the specific brick being changed. */
  readonly brickRef?: BrickRef | undefined;
  /** Optional expiry timestamp (ms). If set, proposal transitions to "expired" after this time. */
  readonly expiresAt?: number | undefined;
  /** Optional structured metadata for the change (schema, diff, etc.). */
  readonly metadata?: JsonObject | undefined;
}

// ---------------------------------------------------------------------------
// Proposal — the full change governance record
// ---------------------------------------------------------------------------

/**
 * A complete proposal record as stored and returned by the gate.
 * Immutable — each state transition produces a new Proposal object.
 */
export interface Proposal {
  /** Gate-assigned unique identifier. */
  readonly id: ProposalId;
  /** Agent ID of the submitter. */
  readonly submittedBy: AgentId;
  /** Which architectural layer this change targets. */
  readonly changeTarget: ChangeTarget;
  /** What kind of operation is being requested. */
  readonly changeKind: ChangeKind;
  /** Human-readable description of what is being changed and why. */
  readonly description: string;
  /** Optional reference to the specific brick being changed. */
  readonly brickRef?: BrickRef | undefined;
  /** Current lifecycle state. */
  readonly status: ProposalStatus;
  /** Unix timestamp (ms) when the proposal was submitted. */
  readonly submittedAt: number;
  /** Optional expiry timestamp (ms). */
  readonly expiresAt?: number | undefined;
  /** Unix timestamp (ms) when the proposal was reviewed. Set when status is approved or rejected. */
  readonly reviewedAt?: number | undefined;
  /** The review verdict. Set when status is approved or rejected. */
  readonly reviewDecision?: ReviewDecision | undefined;
  /** The proposal that replaced this one. Set when status is "superseded". */
  readonly supersededBy?: ProposalId | undefined;
  /** Optional structured metadata for the change (schema, diff, etc.). */
  readonly metadata?: JsonObject | undefined;
}

// ---------------------------------------------------------------------------
// ProposalResult — return type for submit
// ---------------------------------------------------------------------------

/** Result of submitting a proposal. */
export type ProposalResult = Result<Proposal, KoiError>;

// ---------------------------------------------------------------------------
// ProposalUnsubscribe — return type for watch
// ---------------------------------------------------------------------------

/** Call to stop receiving proposal events from a ProposalGate.watch() subscription. */
export type ProposalUnsubscribe = () => void;

// ---------------------------------------------------------------------------
// ProposalGate — the narrow submit/review/watch interface
// ---------------------------------------------------------------------------

/**
 * Submit/review interface for change governance.
 * Separate from KoiMiddleware.ApprovalHandler — this is for structural
 * layer changes (persistent, cross-session) not per-tool-call approval (in-turn).
 *
 * Methods return T | Promise<T> per the L0 async-by-default-for-I/O pattern:
 * in-memory gates return sync values; HTTP-backed gates return Promises.
 * Callers must always await.
 */
export interface ProposalGate {
  /**
   * Submit a change proposal to the gate.
   * The gate assigns id, status ("pending"), and submittedAt.
   * Returns the created Proposal on success, or a KoiError on validation failure.
   */
  readonly submit: (input: ProposalInput) => ProposalResult | Promise<ProposalResult>;

  /**
   * Record a review decision for a pending proposal.
   * Transitions the proposal to "approved" or "rejected".
   * No-op if the proposal is already in a terminal state.
   */
  readonly review: (id: ProposalId, decision: ReviewDecision) => void | Promise<void>;

  /**
   * Subscribe to proposal lifecycle events.
   * Returns a ProposalUnsubscribe function — call it to stop receiving events.
   * Handler may be sync or async; the gate does not await handler results.
   */
  readonly watch: (handler: (event: ProposalEvent) => void | Promise<void>) => ProposalUnsubscribe;
}
