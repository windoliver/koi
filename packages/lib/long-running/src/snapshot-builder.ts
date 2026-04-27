/**
 * Pure builder for HarnessSnapshot. No I/O.
 */

import type {
  AgentId,
  ContextSummary,
  HarnessId,
  HarnessMetrics,
  HarnessPhase,
  HarnessSnapshot,
  KeyArtifact,
  TaskBoardSnapshot,
} from "@koi/core";

export interface SnapshotBuilderInput {
  readonly harnessId: HarnessId;
  readonly agentId: AgentId;
  readonly phase: HarnessPhase;
  readonly sessionSeq: number;
  readonly taskBoard: TaskBoardSnapshot;
  readonly summaries: readonly ContextSummary[];
  readonly keyArtifacts: readonly KeyArtifact[];
  readonly metrics: HarnessMetrics;
  readonly startedAt: number;
  readonly checkpointedAt: number;
  readonly lastSessionId?: string | undefined;
  readonly failureReason?: string | undefined;
}

export function buildHarnessSnapshot(input: SnapshotBuilderInput): HarnessSnapshot {
  return {
    harnessId: input.harnessId,
    phase: input.phase,
    sessionSeq: input.sessionSeq,
    taskBoard: input.taskBoard,
    summaries: input.summaries,
    keyArtifacts: input.keyArtifacts,
    lastSessionId: input.lastSessionId,
    agentId: input.agentId as string,
    metrics: input.metrics,
    startedAt: input.startedAt,
    checkpointedAt: input.checkpointedAt,
    failureReason: input.failureReason,
  };
}

export const EMPTY_TASK_BOARD: TaskBoardSnapshot = Object.freeze({
  items: Object.freeze([]) as TaskBoardSnapshot["items"],
  results: Object.freeze([]) as TaskBoardSnapshot["results"],
});

export const ZERO_METRICS: HarnessMetrics = Object.freeze({
  totalSessions: 0,
  totalTurns: 0,
  totalInputTokens: 0,
  totalOutputTokens: 0,
  completedTaskCount: 0,
  pendingTaskCount: 0,
  elapsedMs: 0,
});
