/**
 * ATIF (Agent Trajectory Interchange Format) v1.6 types.
 *
 * Snake_case per ATIF spec. Used for debugging, replay, SFT, RL, and
 * ecosystem interop. Ported from archive/v1/packages/mm/middleware-ace/src/atif.ts.
 */

import type { JsonObject } from "@koi/core";

/** ATIF root document. */
export interface AtifDocument {
  readonly schema_version: "ATIF-v1.6";
  readonly session_id: string;
  readonly agent: AtifAgent;
  readonly steps: readonly AtifStep[];
  readonly notes?: string;
  readonly final_metrics?: AtifFinalMetrics;
  readonly extra?: JsonObject;
}

/** ATIF agent metadata. */
export interface AtifAgent {
  readonly name: string;
  readonly version?: string;
  readonly model_name?: string;
  readonly tool_definitions?: readonly AtifToolDefinition[];
  readonly extra?: JsonObject;
}

/** ATIF tool definition. */
export interface AtifToolDefinition {
  readonly name: string;
  readonly description?: string;
  readonly parameters?: JsonObject;
}

/** ATIF step — one per agent action. */
export interface AtifStep {
  readonly step_id: number;
  readonly source: "agent" | "tool" | "user" | "system";
  readonly timestamp: string;
  readonly message?: string;
  readonly model_name?: string;
  readonly reasoning_content?: string;
  readonly tool_calls?: readonly AtifToolCall[];
  readonly observation?: AtifObservation;
  readonly metrics?: AtifStepMetrics;
  readonly duration_ms?: number;
  readonly outcome?: "success" | "failure" | "retry";
  readonly extra?: JsonObject;
}

/** ATIF tool call within a step. */
export interface AtifToolCall {
  readonly tool_call_id: string;
  readonly function_name: string;
  readonly arguments?: JsonObject;
}

/** ATIF observation — result of tool execution. */
export interface AtifObservation {
  readonly results?: readonly AtifObservationResult[];
}

/** ATIF observation result. */
export interface AtifObservationResult {
  readonly source_call_id?: string;
  readonly content: string;
}

/** ATIF per-step metrics. */
export interface AtifStepMetrics {
  readonly prompt_tokens?: number;
  readonly completion_tokens?: number;
  readonly cached_tokens?: number;
  readonly cost_usd?: number;
}

/** ATIF final metrics. */
export interface AtifFinalMetrics {
  readonly total_prompt_tokens?: number;
  readonly total_completion_tokens?: number;
  readonly total_cached_tokens?: number;
  readonly total_cost_usd?: number;
  readonly total_steps?: number;
  readonly extra?: JsonObject;
}
