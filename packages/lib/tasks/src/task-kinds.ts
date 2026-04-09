/**
 * Runtime task kind types — discriminated union of all task variants.
 *
 * These are runtime wrappers around the persistent Task record. They carry
 * process handles, abort controllers, and output streams that only exist
 * while the task is actively running.
 *
 * Task IDs come from ManagedTaskBoard.nextId() — no parallel ID generation.
 * Task kind is stored in task.metadata.kind.
 */

import type { TaskItemId, TaskKindName } from "@koi/core";
import { isValidTaskKindName } from "@koi/core";
import type { TaskOutputStream } from "./output-stream.js";

// ---------------------------------------------------------------------------
// Base shape — shared by all runtime task kinds
// ---------------------------------------------------------------------------

export interface RuntimeTaskBase {
  readonly kind: TaskKindName;
  readonly taskId: TaskItemId;
  /** Cancel the running task (wraps AbortController internally). */
  readonly cancel: () => void;
  readonly output: TaskOutputStream;
  readonly startedAt: number;
}

// ---------------------------------------------------------------------------
// Concrete task kinds
// ---------------------------------------------------------------------------

export interface LocalShellTask extends RuntimeTaskBase {
  readonly kind: "local_shell";
  readonly command: string;
}

export interface LocalAgentTask extends RuntimeTaskBase {
  readonly kind: "local_agent";
  readonly agentType: string;
}

export interface RemoteAgentTask extends RuntimeTaskBase {
  readonly kind: "remote_agent";
  readonly endpoint: string;
  readonly correlationId: string;
}

export interface InProcessTeammateTask extends RuntimeTaskBase {
  readonly kind: "in_process_teammate";
  readonly identity: TeammateIdentity;
  /** Returns an immutable snapshot of the current plan approval state. */
  readonly planApprovalState: () => PlanApprovalSnapshot;
}

export interface DreamTask extends RuntimeTaskBase {
  readonly kind: "dream";
}

// ---------------------------------------------------------------------------
// Union type
// ---------------------------------------------------------------------------

export type RuntimeTask =
  | LocalShellTask
  | LocalAgentTask
  | RemoteAgentTask
  | InProcessTeammateTask
  | DreamTask;

// ---------------------------------------------------------------------------
// Supporting types
// ---------------------------------------------------------------------------

/** Immutable snapshot of plan approval state — updated by replacement, not mutation. */
export interface PlanApprovalSnapshot {
  readonly awaiting: boolean;
  readonly requestedAt?: number;
}

/** Structured teammate identity. */
export interface TeammateIdentity {
  readonly agentId: string;
  readonly agentName: string;
  readonly teamName: string;
  readonly planModeRequired: boolean;
}

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

export function isRuntimeTask(value: unknown): value is RuntimeTask {
  if (typeof value !== "object" || value === null) return false;
  const kind = (value as Readonly<Record<string, unknown>>).kind;
  return typeof kind === "string" && isValidTaskKindName(kind);
}

export function isLocalShellTask(value: unknown): value is LocalShellTask {
  return isRuntimeTask(value) && value.kind === "local_shell";
}

export function isLocalAgentTask(value: unknown): value is LocalAgentTask {
  return isRuntimeTask(value) && value.kind === "local_agent";
}

export function isRemoteAgentTask(value: unknown): value is RemoteAgentTask {
  return isRuntimeTask(value) && value.kind === "remote_agent";
}

export function isInProcessTeammateTask(value: unknown): value is InProcessTeammateTask {
  return isRuntimeTask(value) && value.kind === "in_process_teammate";
}

export function isDreamTask(value: unknown): value is DreamTask {
  return isRuntimeTask(value) && value.kind === "dream";
}
