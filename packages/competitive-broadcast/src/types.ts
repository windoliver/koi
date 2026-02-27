/**
 * @koi/competitive-broadcast — Core types for competitive selection + broadcast.
 *
 * Defines the Proposal data type, selection/broadcast contracts, cycle events,
 * and branded ProposalId. All types are L2-local (no L0 changes needed).
 */

import type { AgentId } from "@koi/core/ecs";
import type { KoiError, Result } from "@koi/core/errors";

// ---------------------------------------------------------------------------
// Branded ProposalId
// ---------------------------------------------------------------------------

declare const __proposalBrand: unique symbol;

/** Branded string type for proposal identifiers. */
export type ProposalId = string & { readonly [__proposalBrand]: "ProposalId" };

/** Create a branded ProposalId from a plain string. */
export function proposalId(id: string): ProposalId {
  return id as ProposalId;
}

// ---------------------------------------------------------------------------
// Proposal
// ---------------------------------------------------------------------------

/** A competing agent's output submitted for selection. */
export interface Proposal {
  readonly id: ProposalId;
  readonly agentId: AgentId;
  readonly output: string;
  readonly durationMs: number;
  readonly submittedAt: number;
  /** Salience score in [0, 1] — used by scored selection. */
  readonly salience?: number | undefined;
  readonly metadata?: Readonly<Record<string, unknown>> | undefined;
}

// ---------------------------------------------------------------------------
// Selection strategy contract
// ---------------------------------------------------------------------------

/** Pluggable strategy for choosing a winning proposal. */
export interface SelectionStrategy {
  readonly name: string;
  readonly select: (
    proposals: readonly Proposal[],
  ) => Result<Proposal, KoiError> | Promise<Result<Proposal, KoiError>>;
}

// ---------------------------------------------------------------------------
// Broadcast types
// ---------------------------------------------------------------------------

/** The result of a competitive selection cycle, ready for broadcast. */
export interface BroadcastResult {
  readonly winner: Proposal;
  readonly allProposals: readonly Proposal[];
  readonly cycleId: string;
}

/** Report from a broadcast delivery attempt. */
export interface BroadcastReport {
  readonly delivered: number;
  readonly failed: number;
  readonly errors?: readonly unknown[] | undefined;
}

/** Pluggable sink for delivering broadcast results. */
export interface BroadcastSink {
  readonly broadcast: (result: BroadcastResult) => Promise<BroadcastReport>;
}

// ---------------------------------------------------------------------------
// Cycle events (discriminated union)
// ---------------------------------------------------------------------------

/** Observable events emitted during a competitive broadcast cycle. */
export type CycleEvent =
  | { readonly kind: "selection_started"; readonly proposalCount: number }
  | { readonly kind: "winner_selected"; readonly winner: Proposal }
  | { readonly kind: "broadcast_started"; readonly winnerId: ProposalId }
  | { readonly kind: "broadcast_complete"; readonly report: BroadcastReport }
  | { readonly kind: "cycle_error"; readonly error: KoiError };

// ---------------------------------------------------------------------------
// Consensus vote (used by consensus selector)
// ---------------------------------------------------------------------------

/** A vote cast by a judge for a specific proposal. */
export interface Vote {
  readonly proposalId: ProposalId;
  readonly score: number;
}

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

/** Type guard for Proposal values. */
export function isProposal(value: unknown): value is Proposal {
  if (value === null || value === undefined || typeof value !== "object") {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.id === "string" &&
    typeof candidate.agentId === "string" &&
    typeof candidate.output === "string" &&
    typeof candidate.durationMs === "number" &&
    typeof candidate.submittedAt === "number"
  );
}
