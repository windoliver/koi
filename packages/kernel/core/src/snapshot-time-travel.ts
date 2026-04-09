/**
 * Time-travel types — filesystem side-effect journal, backtrack constraints,
 * and per-event trace types for rewind, guided retry, and event-level granularity.
 *
 * Used by L2 packages:
 *   - @koi/checkpoint (FileOpRecord, CompensatingOp, SnapshotStatus, SNAPSHOT_STATUS_KEY)
 *   - @koi/snapshot-store-sqlite (storage adapter for SnapshotChainStore<AgentSnapshot>)
 *   - @koi/middleware-guided-retry (BacktrackReason, BacktrackConstraint)
 *   - @koi/middleware-event-trace (TraceEventKind, TraceEvent, TurnTrace, EventCursor)
 *
 * File content is referenced by SHA-256 content hash, never literal bytes — the
 * actual contents live in a content-addressed blob store managed by the L2
 * checkpoint package. This keeps L0 free of binary file concerns and lets the
 * snapshot chain store dedup file content automatically.
 */

import type { SessionId, ToolCallId } from "./ecs.js";

// ---------------------------------------------------------------------------
// Feature 1: Filesystem side-effect journal
// ---------------------------------------------------------------------------

/** Kind of filesystem operation that can be rewound. */
export type FileOpKind = "create" | "edit" | "delete";

/**
 * Fields shared by every FileOpRecord variant. Per-kind fields (content
 * hashes) are added by the discriminated union below.
 */
interface FileOpRecordBase {
  /** Identifier of the tool call that produced this operation. */
  readonly callId: ToolCallId;
  /** Absolute path to the affected file. */
  readonly path: string;
  /** Which turn this operation occurred in. */
  readonly turnIndex: number;
  /** Index within the event trace for cross-feature correlation. -1 = uncorrelated. */
  readonly eventIndex: number;
  /** Unix timestamp ms when this operation was captured. */
  readonly timestamp: number;
  /**
   * Optional shared identifier when a delete + create pair originated as a
   * rename. Lets the rewind UI present them as one operation.
   */
  readonly renameId?: string;
}

/**
 * Record of a single file operation captured during a tool call.
 *
 * Discriminated by `kind`. Content is stored as a SHA-256 hex hash that
 * dereferences to a blob in the CAS store managed by `@koi/checkpoint`; the
 * L0 type itself never carries file bytes (so binary files are supported and
 * large files don't bloat snapshot payloads).
 *
 * Renames are modeled as a `delete + create` pair sharing a `renameId` rather
 * than a fourth `kind: "rename"` — Rule of Three: don't add a primitive until
 * a third operation needs it.
 */
export type FileOpRecord =
  | (FileOpRecordBase & {
      readonly kind: "create";
      /** SHA-256 hex of the file content after creation. */
      readonly postContentHash: string;
    })
  | (FileOpRecordBase & {
      readonly kind: "edit";
      /** SHA-256 hex of the file content before the edit. */
      readonly preContentHash: string;
      /** SHA-256 hex of the file content after the edit. */
      readonly postContentHash: string;
    })
  | (FileOpRecordBase & {
      readonly kind: "delete";
      /** SHA-256 hex of the file content before deletion. */
      readonly preContentHash: string;
    });

/**
 * Action needed to undo a file operation.
 *
 * `restore` carries a content hash that the L2 checkpoint package looks up in
 * its CAS blob store. This avoids inlining file bytes in the L0 type and lets
 * the same hash be reused across many compensating ops without duplication.
 */
export type CompensatingOp =
  | { readonly kind: "restore"; readonly path: string; readonly contentHash: string }
  | { readonly kind: "delete"; readonly path: string };

// ---------------------------------------------------------------------------
// Feature 1b: Snapshot status (soft-fail contract)
// ---------------------------------------------------------------------------

/**
 * Status of a snapshot record. Snapshots are written to the chain store
 * regardless of whether their capture step fully succeeded; failed captures
 * are recorded as `incomplete` and skipped on rewind with a user-visible
 * warning. This is the soft-fail contract documented in `docs/L2/checkpoint.md`
 * — checkpoint creation MUST NOT abort the agent loop.
 *
 * The status is stored in `SnapshotNode.metadata` under `SNAPSHOT_STATUS_KEY`.
 * Absent or `"complete"` means the snapshot is restorable.
 */
export type SnapshotStatus = "complete" | "incomplete";

/**
 * Metadata key used to store SnapshotStatus on `SnapshotNode.metadata`.
 * Convention: `koi:` prefix for framework-owned keys.
 */
export const SNAPSHOT_STATUS_KEY = "koi:snapshot_status" as const;

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
