/**
 * Rich trajectory types — full execution traces for LLM-based reflection (Layer 0).
 *
 * Extends the compact TrajectoryEntry (kind + identifier + outcome) with full
 * request/response content, reasoning traces, and token metrics. Used by the
 * ACE LLM pipeline (reflector + curator) for deeper semantic learning.
 *
 * Compact trajectories remain the source for stat-based pipelines; rich
 * trajectories feed LLM reflection only.
 */

import type { JsonObject } from "./common.js";

/** Content payload with optional truncation metadata. */
export interface RichContent {
  readonly text?: string;
  /** True when content was truncated from its original size. */
  readonly truncated?: boolean;
  /** Original byte size before truncation (if truncated). */
  readonly originalSize?: number;
  /** Structured data when text is not sufficient (e.g. tool arguments). */
  readonly data?: JsonObject;
}

/** Per-step token and cost metrics. */
export interface RichStepMetrics {
  readonly promptTokens?: number;
  readonly completionTokens?: number;
  readonly cachedTokens?: number;
  readonly costUsd?: number;
}

/** Rich trajectory step — one per model/tool call with full I/O content. */
export interface RichTrajectoryStep {
  readonly stepIndex: number;
  readonly timestamp: number;
  readonly source: "agent" | "tool" | "user" | "system";
  readonly kind: "model_call" | "tool_call";
  readonly identifier: string;
  readonly outcome: "success" | "failure" | "retry";
  readonly durationMs: number;

  /** Request content (model prompt or tool arguments). */
  readonly request?: RichContent;
  /** Response content (model output or tool result). */
  readonly response?: RichContent;
  /** Error content when outcome is "failure". */
  readonly error?: RichContent;
  /** Model reasoning/chain-of-thought trace. */
  readonly reasoningContent?: string;

  /** Token/cost metrics for this step. */
  readonly metrics?: RichStepMetrics;

  /** Cited structured playbook bullet IDs (e.g. "[str-00001]"). */
  readonly bulletIds?: readonly string[];
  /** Opaque extension data for adapter-specific fields. */
  readonly metadata?: JsonObject;
}

/** Store for rich trajectory data — append-heavy, per-session, with TTL pruning. */
export interface RichTrajectoryStore {
  /** Append rich trajectory steps for a session. */
  readonly append: (sessionId: string, steps: readonly RichTrajectoryStep[]) => Promise<void>;
  /** Retrieve all rich steps for a session. */
  readonly getSession: (sessionId: string) => Promise<readonly RichTrajectoryStep[]>;
  /** Delete entries older than the given timestamp. Returns count of pruned entries. */
  readonly prune: (olderThanMs: number) => Promise<number>;
}
