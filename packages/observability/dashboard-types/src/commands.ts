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
// Command dispatcher interface
// ---------------------------------------------------------------------------

export interface CommandDispatcher {
  readonly suspendAgent: (
    agentId: AgentId,
  ) => Result<void, KoiError> | Promise<Result<void, KoiError>>;

  readonly resumeAgent: (
    agentId: AgentId,
  ) => Result<void, KoiError> | Promise<Result<void, KoiError>>;

  readonly terminateAgent: (
    agentId: AgentId,
  ) => Result<void, KoiError> | Promise<Result<void, KoiError>>;

  readonly retryDeadLetter?: (
    entryId: string,
  ) => Result<void, KoiError> | Promise<Result<void, KoiError>>;

  readonly listMailbox?: (
    agentId: AgentId,
  ) => readonly AgentMessage[] | Promise<readonly AgentMessage[]>;
}
