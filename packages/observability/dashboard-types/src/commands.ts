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
}
