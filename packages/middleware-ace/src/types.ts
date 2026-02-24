/**
 * Core domain types for the ACE (Adaptive Continuous Enhancement) middleware.
 */

import type { JsonObject } from "@koi/core/common";

/** Trajectory entry — one per model/tool call within a session. */
export interface TrajectoryEntry {
  readonly turnIndex: number;
  readonly timestamp: number;
  readonly kind: "model_call" | "tool_call";
  readonly identifier: string;
  readonly outcome: "success" | "failure" | "retry";
  readonly durationMs: number;
  readonly metadata?: JsonObject;
}

/** Running stats per unique identifier (incremental aggregation). */
export interface AggregatedStats {
  readonly identifier: string;
  readonly kind: "model_call" | "tool_call";
  readonly successes: number;
  readonly failures: number;
  readonly retries: number;
  readonly totalDurationMs: number;
  readonly invocations: number;
  readonly lastSeenMs: number;
}

/** Playbook — a consolidated learning artifact. */
export interface Playbook {
  readonly id: string;
  readonly title: string;
  readonly strategy: string;
  readonly tags: readonly string[];
  readonly confidence: number;
  readonly source: PlaybookSource;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly sessionCount: number;
}

export type PlaybookSource = "curated" | "manual" | "imported";

/** Curation result — what the curator produces from a session. */
export interface CurationCandidate {
  readonly identifier: string;
  readonly kind: "model_call" | "tool_call";
  readonly score: number;
  readonly stats: AggregatedStats;
}

/** Feedback signal from turn metadata. */
export interface AceFeedback {
  readonly rating?: number;
  readonly tags?: readonly string[];
  readonly note?: string;
}
