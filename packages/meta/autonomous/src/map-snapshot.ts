/**
 * Pure mapping functions — convert HarnessSnapshot fields to HandoffEnvelope fields.
 *
 * All functions are pure, side-effect-free, and operate only on L0 types.
 */

import type {
  AgentId,
  ArtifactRef,
  ContextSummary,
  DecisionRecord,
  HandoffEnvelope,
  HarnessSnapshot,
  JsonObject,
  KeyArtifact,
  TaskResult,
} from "@koi/core";
import { agentId, handoffId } from "@koi/core";

// ---------------------------------------------------------------------------
// mapKeyArtifactToArtifactRef
// ---------------------------------------------------------------------------

/** Map a harness KeyArtifact to a handoff ArtifactRef with harness:// URI scheme. */
export function mapKeyArtifactToArtifactRef(artifact: KeyArtifact, index: number): ArtifactRef {
  const preview =
    artifact.content.length > 200 ? `${artifact.content.slice(0, 200)}...` : artifact.content;

  return {
    id: `artifact-${String(index)}`,
    kind: "data",
    uri: `harness://artifact/${encodeURIComponent(artifact.toolName)}/${String(artifact.turnIndex)}`,
    metadata: {
      toolName: artifact.toolName,
      turnIndex: artifact.turnIndex,
      capturedAt: artifact.capturedAt,
      preview,
    },
  };
}

// ---------------------------------------------------------------------------
// mapContextSummaryToDecisionRecord
// ---------------------------------------------------------------------------

/** Map a harness ContextSummary to a handoff DecisionRecord. */
export function mapContextSummaryToDecisionRecord(
  summary: ContextSummary,
  sourceAgentId: AgentId,
): DecisionRecord {
  return {
    agentId: sourceAgentId,
    action: `session-${String(summary.sessionSeq)}-summary`,
    reasoning: summary.narrative,
    timestamp: summary.generatedAt,
  };
}

// ---------------------------------------------------------------------------
// mapTaskResultsToJsonObject
// ---------------------------------------------------------------------------

/** Map task results to a JSON object keyed by taskId. */
export function mapTaskResultsToJsonObject(results: readonly TaskResult[]): JsonObject {
  const obj: Record<string, unknown> = {};
  for (const result of results) {
    obj[result.taskId] = {
      output: result.output,
      durationMs: result.durationMs,
      ...(result.workerId !== undefined ? { workerId: result.workerId } : {}),
    };
  }
  return obj as JsonObject;
}

// ---------------------------------------------------------------------------
// generateCompletedPhaseDescription
// ---------------------------------------------------------------------------

/** Generate a human-readable summary of the completed harness phase. */
export function generateCompletedPhaseDescription(snapshot: HarnessSnapshot): string {
  const completedCount = snapshot.metrics.completedTaskCount;
  const totalCount = completedCount + snapshot.metrics.pendingTaskCount;
  const sessions = snapshot.metrics.totalSessions;
  const elapsedSec = Math.round(snapshot.metrics.elapsedMs / 1000);

  return `Completed ${String(completedCount)}/${String(totalCount)} tasks across ${String(sessions)} session${sessions === 1 ? "" : "s"} (${String(elapsedSec)}s elapsed)`;
}

// ---------------------------------------------------------------------------
// generateWarnings
// ---------------------------------------------------------------------------

/** Generate warnings for failed tasks and high session counts. */
export function generateWarnings(snapshot: HarnessSnapshot): readonly string[] {
  const warnings: string[] = [];

  const failedItems = snapshot.taskBoard.items.filter((item) => item.status === "failed");
  for (const item of failedItems) {
    warnings.push(`Task "${item.id}" failed: ${item.error?.message ?? "unknown error"}`);
  }

  const HIGH_SESSION_THRESHOLD = 10;
  if (snapshot.metrics.totalSessions > HIGH_SESSION_THRESHOLD) {
    warnings.push(`High session count: ${String(snapshot.metrics.totalSessions)} sessions used`);
  }

  return warnings;
}

// ---------------------------------------------------------------------------
// mapSnapshotToEnvelope
// ---------------------------------------------------------------------------

/** Map a completed HarnessSnapshot to a HandoffEnvelope. */
export function mapSnapshotToEnvelope(
  snapshot: HarnessSnapshot,
  targetAgentId: AgentId,
  nextPhaseInstructions?: string,
): HandoffEnvelope {
  const sourceAgentId = agentId(snapshot.agentId);

  const artifacts = snapshot.keyArtifacts.map((a, i) => mapKeyArtifactToArtifactRef(a, i));
  const decisions = snapshot.summaries.map((s) =>
    mapContextSummaryToDecisionRecord(s, sourceAgentId),
  );
  const results = mapTaskResultsToJsonObject(snapshot.taskBoard.results);
  const warnings = generateWarnings(snapshot);
  const completedDescription = generateCompletedPhaseDescription(snapshot);

  return {
    id: handoffId(`harness-handoff-${snapshot.harnessId}-${String(snapshot.sessionSeq)}`),
    from: sourceAgentId,
    to: targetAgentId,
    status: "pending",
    createdAt: Date.now(),
    phase: {
      completed: completedDescription,
      next: nextPhaseInstructions ?? `Continue from: ${completedDescription}`,
    },
    context: {
      results,
      artifacts,
      decisions,
      warnings,
    },
    metadata: {
      harnessId: snapshot.harnessId,
      sessionSeq: snapshot.sessionSeq,
      elapsedMs: snapshot.metrics.elapsedMs,
    },
  };
}
