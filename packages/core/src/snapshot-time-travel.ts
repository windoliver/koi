/**
 * Time-travel types — filesystem side-effect journal, backtrack constraints,
 * and per-event trace types for rewind, guided retry, and event-level granularity.
 *
 * Used by L2 middleware packages:
 *   - @koi/middleware-fs-rollback (FileOpRecord, CompensatingOp)
 *   - @koi/middleware-guided-retry (BacktrackReason, BacktrackConstraint)
 *   - @koi/middleware-event-trace (TraceEventKind, TraceEvent, TurnTrace, EventCursor)
 */

import type { SessionId, ToolCallId } from "./ecs.js";

// ---------------------------------------------------------------------------
// Feature 1: Filesystem side-effect journal
// ---------------------------------------------------------------------------

/** Kind of filesystem operation that can be rewound. */
export type FileOpKind = "write" | "edit";

/** Record of a single file operation captured during a tool call. */
export interface FileOpRecord {
  /** Identifier of the tool call that produced this operation. */
  readonly callId: ToolCallId;
  /** Kind of file operation. */
  readonly kind: FileOpKind;
  /** Absolute path to the affected file. */
  readonly path: string;
  /** File content before the operation. undefined = file did not exist. */
  readonly previousContent: string | undefined;
  /** File content after the operation. */
  readonly newContent: string;
  /** Which turn this operation occurred in. */
  readonly turnIndex: number;
  /** Index within the event trace for cross-feature correlation. -1 = uncorrelated. */
  readonly eventIndex: number;
  /** Unix timestamp ms when this operation was captured. */
  readonly timestamp: number;
}

/** Action needed to undo a file operation. */
export type CompensatingOp =
  | { readonly kind: "restore"; readonly path: string; readonly content: string }
  | { readonly kind: "delete"; readonly path: string };

// ---------------------------------------------------------------------------
// Feature 2: Backtrack reason + constraint
// ---------------------------------------------------------------------------

/** Why a backtrack/fork was triggered. */
export type BacktrackReasonKind =
  | "validation_failure"
  | "gate_failure"
  | "user_rejection"
  | "timeout"
  | "error"
  | "manual";

/** Structured reason for a backtrack event. */
export interface BacktrackReason {
  readonly kind: BacktrackReasonKind;
  readonly message: string;
  readonly details?: Readonly<Record<string, unknown>>;
  /** NodeId of the snapshot that was abandoned (if available). */
  readonly abandonedNodeId?: string;
  readonly timestamp: number;
}

/** Constraint injected into the model call after a backtrack. */
export interface BacktrackConstraint {
  readonly reason: BacktrackReason;
  /** Free-text guidance for the model (e.g., "prefer X", "avoid Y"). */
  readonly instructions?: string;
  /** Maximum number of model calls to inject this constraint into. Default: 1. */
  readonly maxInjections?: number;
}

/**
 * Metadata key used to store BacktrackReason in AgentSnapshot.metadata.
 * Convention: `koi:` prefix for framework-owned keys.
 */
export const BACKTRACK_REASON_KEY = "koi:backtrack_reason" as const;

// ---------------------------------------------------------------------------
// Feature 3: Per-event trace
// ---------------------------------------------------------------------------

/** Discriminated union of traceable event kinds. */
export type TraceEventKind =
  | {
      readonly kind: "model_call";
      readonly request: unknown;
      readonly response: unknown;
      readonly durationMs: number;
    }
  | {
      readonly kind: "tool_call";
      readonly toolId: string;
      readonly callId: ToolCallId;
      readonly input: unknown;
      readonly output: unknown;
      readonly durationMs: number;
    }
  | {
      readonly kind: "model_stream_start";
      readonly request: unknown;
    }
  | {
      readonly kind: "model_stream_end";
      readonly response: unknown;
      readonly durationMs: number;
    };

/** A single traced event with position metadata. */
export interface TraceEvent {
  /** Monotonic index within the session. */
  readonly eventIndex: number;
  /** Turn this event belongs to. */
  readonly turnIndex: number;
  /** The event payload. */
  readonly event: TraceEventKind;
  /** Unix timestamp ms when this event was recorded. */
  readonly timestamp: number;
}

/** Complete trace of all events within a single turn. */
export interface TurnTrace {
  readonly turnIndex: number;
  readonly sessionId: SessionId;
  readonly agentId: string;
  readonly events: readonly TraceEvent[];
  readonly durationMs: number;
}

/** Cursor pointing to a specific event within the trace. */
export interface EventCursor {
  readonly turnIndex: number;
  readonly eventIndex: number;
}
