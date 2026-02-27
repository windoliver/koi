/**
 * Run report types — structured summary of an autonomous agent run.
 *
 * Pure types only. No runtime code, no imports from other packages.
 * Reuses ArtifactRef from handoff.ts for artifact references.
 */

import type { JsonObject } from "./common.js";
import type { AgentId, RunId, SessionId } from "./ecs.js";
import type { ArtifactRef } from "./handoff.js";

/** A single action (model call or tool call) recorded during a run. */
export interface ActionEntry {
  readonly kind: "model_call" | "tool_call";
  readonly name: string;
  readonly turnIndex: number;
  readonly durationMs: number;
  readonly success: boolean;
  readonly errorMessage?: string | undefined;
  readonly tokenUsage?:
    | {
        readonly inputTokens: number;
        readonly outputTokens: number;
      }
    | undefined;
}

/** An issue (error, warning, informational) encountered during a run. */
export interface IssueEntry {
  readonly severity: "critical" | "warning" | "info";
  readonly message: string;
  readonly turnIndex: number;
  readonly resolved: boolean;
  readonly resolution?: string | undefined;
}

/** AI-generated or template summary with recommendations. */
export interface ReportSummary {
  readonly summary: string;
  readonly recommendations: readonly string[];
}

/** Timing metadata for the run. */
export interface RunDuration {
  readonly startedAt: number;
  readonly completedAt: number;
  readonly durationMs: number;
  readonly totalTurns: number;
  readonly totalActions: number;
  readonly truncated: boolean;
}

/** Token usage and estimated cost for the run. */
export interface RunCost {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly estimatedCostUsd?: number | undefined;
}

/** Structured report of an autonomous agent run. */
export interface RunReport {
  readonly agentId: AgentId;
  readonly sessionId: SessionId;
  readonly runId: RunId;
  readonly summary: string;
  readonly objective?: string | undefined;
  readonly duration: RunDuration;
  readonly actions: readonly ActionEntry[];
  readonly artifacts: readonly ArtifactRef[];
  readonly issues: readonly IssueEntry[];
  readonly cost: RunCost;
  readonly recommendations: readonly string[];
  readonly childReports?: readonly RunReport[] | undefined;
  readonly metadata?: JsonObject | undefined;
}

/** Persistence backend for run reports. */
export interface ReportStore {
  readonly put: (report: RunReport) => void | Promise<void>;
  readonly getBySession: (
    sessionId: SessionId,
  ) => readonly RunReport[] | Promise<readonly RunReport[]>;
}
