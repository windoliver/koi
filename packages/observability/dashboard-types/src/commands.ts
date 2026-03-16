/**
 * CommandDispatcher — imperative operations for the admin panel.
 *
 * These are non-file actions exposed via POST /api/cmd/* endpoints.
 * All methods return Result<T, KoiError> for expected failures.
 */

import type { AgentId, KoiError, Result } from "@koi/core";

// ---------------------------------------------------------------------------
// Agent message (mailbox)
// ---------------------------------------------------------------------------

export interface AgentMessage {
  readonly id: string;
  readonly from: AgentId;
  readonly to: AgentId;
  readonly content: string;
  readonly timestamp: number;
}

// ---------------------------------------------------------------------------
// Dispatch types
// ---------------------------------------------------------------------------

/** Request body for POST /cmd/agents/dispatch. */
export interface DispatchAgentRequest {
  /** Display name for the new agent (required). */
  readonly name: string;
  /** Optional manifest path or inline manifest to use. */
  readonly manifest?: string;
  /** Optional initial message to send to the agent after dispatch. */
  readonly message?: string;
  /** Agent type for lifecycle management. Default: "copilot". */
  readonly agentType?: "copilot" | "worker" | undefined;
}

/** Response body for a successful dispatch. */
export interface DispatchAgentResponse {
  /** The ID assigned to the newly dispatched agent. */
  readonly agentId: AgentId;
  /** Display name echoed back. */
  readonly name: string;
}

// ---------------------------------------------------------------------------
// Command dispatcher interface
// ---------------------------------------------------------------------------

export interface CommandDispatcher {
  // Agent dispatch
  readonly dispatchAgent?: (
    request: DispatchAgentRequest,
  ) => Result<DispatchAgentResponse, KoiError> | Promise<Result<DispatchAgentResponse, KoiError>>;

  // Agent lifecycle
  readonly suspendAgent: (
    agentId: AgentId,
  ) => Result<void, KoiError> | Promise<Result<void, KoiError>>;

  readonly resumeAgent: (
    agentId: AgentId,
  ) => Result<void, KoiError> | Promise<Result<void, KoiError>>;

  readonly terminateAgent: (
    agentId: AgentId,
  ) => Result<void, KoiError> | Promise<Result<void, KoiError>>;

  // Event DLQ
  readonly retryDeadLetter?: (
    entryId: string,
  ) => Result<boolean, KoiError> | Promise<Result<boolean, KoiError>>;

  // Mailbox (Decision 7A: standardized to Result)
  readonly listMailbox?: (
    agentId: AgentId,
  ) =>
    | Result<readonly AgentMessage[], KoiError>
    | Promise<Result<readonly AgentMessage[], KoiError>>;

  // Phase 2: Temporal commands
  readonly signalWorkflow?: (
    id: string,
    signal: string,
    payload: unknown,
  ) => Promise<Result<void, KoiError>>;

  readonly terminateWorkflow?: (id: string) => Promise<Result<void, KoiError>>;

  // Phase 2: Scheduler commands
  readonly pauseSchedule?: (id: string) => Promise<Result<void, KoiError>>;

  readonly resumeSchedule?: (id: string) => Promise<Result<void, KoiError>>;

  readonly deleteSchedule?: (id: string) => Promise<Result<void, KoiError>>;

  readonly retrySchedulerDeadLetter?: (id: string) => Promise<Result<void, KoiError>>;

  // Phase 2: Harness commands
  readonly pauseHarness?: () => Promise<Result<void, KoiError>>;

  readonly resumeHarness?: () => Promise<Result<void, KoiError>>;

  // Delegation chain
  readonly listDelegations?: (
    agentId: AgentId,
  ) =>
    | Result<readonly DelegationSummary[], KoiError>
    | Promise<Result<readonly DelegationSummary[], KoiError>>;

  // Handoff tracking
  readonly listHandoffs?: (
    agentId: AgentId,
  ) =>
    | Result<readonly HandoffSummary[], KoiError>
    | Promise<Result<readonly HandoffSummary[], KoiError>>;

  // Scratchpad
  readonly listScratchpad?: (
    groupId?: string,
  ) =>
    | Result<readonly ScratchpadEntrySummary[], KoiError>
    | Promise<Result<readonly ScratchpadEntrySummary[], KoiError>>;

  readonly readScratchpad?: (
    path: string,
  ) => Result<ScratchpadEntryDetail, KoiError> | Promise<Result<ScratchpadEntryDetail, KoiError>>;

  // Governance review
  readonly reviewGovernance?: (
    id: string,
    decision: "approved" | "rejected",
    reason?: string,
  ) => Result<void, KoiError> | Promise<Result<void, KoiError>>;

  readonly listGovernanceQueue?: () =>
    | Result<readonly GovernancePendingItem[], KoiError>
    | Promise<Result<readonly GovernancePendingItem[], KoiError>>;

  // Forge brick lifecycle
  readonly promoteBrick?: (
    brickId: string,
  ) => Result<void, KoiError> | Promise<Result<void, KoiError>>;

  readonly demoteBrick?: (
    brickId: string,
  ) => Result<void, KoiError> | Promise<Result<void, KoiError>>;

  readonly quarantineBrick?: (
    brickId: string,
  ) => Result<void, KoiError> | Promise<Result<void, KoiError>>;
}

// ---------------------------------------------------------------------------
// Delegation
// ---------------------------------------------------------------------------

export interface DelegationSummary {
  readonly id: string;
  readonly issuerId: string;
  readonly delegateeId: string;
  readonly scope: string;
  readonly expiresAt: number | null;
  readonly chainDepth: number;
}

// ---------------------------------------------------------------------------
// Handoff
// ---------------------------------------------------------------------------

export interface HandoffSummary {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly status: string;
  readonly phase: {
    readonly completed: number;
    readonly next: string;
  };
  readonly createdAt: number;
}

// ---------------------------------------------------------------------------
// Scratchpad
// ---------------------------------------------------------------------------

export interface ScratchpadEntrySummary {
  readonly path: string;
  readonly authorId: string;
  readonly groupId: string;
  readonly sizeBytes: number;
  readonly updatedAt: number;
}

export interface ScratchpadEntryDetail extends ScratchpadEntrySummary {
  readonly content: string;
  readonly generation: number;
}

// ---------------------------------------------------------------------------
// Governance queue
// ---------------------------------------------------------------------------

export interface GovernancePendingItem {
  readonly id: string;
  readonly agentId: string;
  readonly requestKind: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly timestamp: number;
}
