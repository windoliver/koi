/**
 * Long-running harness types — multi-session agent lifecycle management.
 *
 * Provides types for agents that operate over hours/days across multiple
 * sessions, tracking progress, bridging context, and checkpointing at
 * meaningful task boundaries.
 *
 * Exception: branded type constructor (harnessId) is permitted in L0
 * as a zero-logic identity cast for type safety.
 */

import type { SnapshotChainStore } from "./snapshot-chain.js";
import type { TaskBoardSnapshot } from "./task-board.js";

// ---------------------------------------------------------------------------
// Branded types
// ---------------------------------------------------------------------------

declare const __harnessIdBrand: unique symbol;

/** Branded string type for harness identifiers. */
export type HarnessId = string & { readonly [__harnessIdBrand]: "HarnessId" };

/** Create a branded HarnessId from a plain string. */
export function harnessId(raw: string): HarnessId {
  return raw as HarnessId;
}

// ---------------------------------------------------------------------------
// Phase discriminant
// ---------------------------------------------------------------------------

/** Lifecycle phase of a long-running harness. */
export type HarnessPhase = "idle" | "active" | "suspended" | "completed" | "failed";

// ---------------------------------------------------------------------------
// Per-session context summary
// ---------------------------------------------------------------------------

/** Narrative summary generated eagerly at session end. */
export interface ContextSummary {
  readonly narrative: string;
  readonly sessionSeq: number;
  readonly completedTaskIds: readonly string[];
  readonly estimatedTokens: number;
  readonly generatedAt: number;
}

// ---------------------------------------------------------------------------
// Key artifact — notable tool output captured during execution
// ---------------------------------------------------------------------------

export interface KeyArtifact {
  readonly toolName: string;
  readonly content: string;
  readonly turnIndex: number;
  readonly capturedAt: number;
}

// ---------------------------------------------------------------------------
// Accumulated metrics across all sessions
// ---------------------------------------------------------------------------

export interface HarnessMetrics {
  readonly totalSessions: number;
  readonly totalTurns: number;
  readonly totalInputTokens: number;
  readonly totalOutputTokens: number;
  readonly completedTaskCount: number;
  readonly pendingTaskCount: number;
  readonly elapsedMs: number;
}

// ---------------------------------------------------------------------------
// Observable harness status (read by Node/dashboard)
// ---------------------------------------------------------------------------

export interface HarnessStatus {
  readonly harnessId: HarnessId;
  readonly phase: HarnessPhase;
  readonly currentSessionSeq: number;
  readonly taskBoard: TaskBoardSnapshot;
  readonly metrics: HarnessMetrics;
  readonly lastSessionEndedAt?: number | undefined;
  readonly startedAt?: number | undefined;
  readonly failureReason?: string | undefined;
}

// ---------------------------------------------------------------------------
// Durable checkpoint payload — stored in SnapshotChainStore<HarnessSnapshot>
// ---------------------------------------------------------------------------

export interface HarnessSnapshot {
  readonly harnessId: HarnessId;
  readonly phase: HarnessPhase;
  readonly sessionSeq: number;
  readonly taskBoard: TaskBoardSnapshot;
  readonly summaries: readonly ContextSummary[];
  readonly keyArtifacts: readonly KeyArtifact[];
  readonly lastSessionId?: string | undefined;
  readonly agentId: string;
  readonly metrics: HarnessMetrics;
  readonly startedAt: number;
  readonly checkpointedAt: number;
  readonly failureReason?: string | undefined;
}

// ---------------------------------------------------------------------------
// Type alias — follows AgentSnapshotStore pattern from agent-snapshot.ts
// ---------------------------------------------------------------------------

/** A SnapshotChainStore specialized for HarnessSnapshot payloads. */
export type HarnessSnapshotStore = SnapshotChainStore<HarnessSnapshot>;
