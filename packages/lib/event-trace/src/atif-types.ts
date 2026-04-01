/**
 * ATIF (Agent Trajectory Interchange Format) v1.6 type definitions.
 *
 * Implemented from the Harbor framework RFC specification (Apache-2.0):
 * https://github.com/harbor-framework/harbor/blob/main/docs/rfcs/0001-trajectory-format.md
 *
 * Schema version: ATIF-v1.6
 *
 * No Harbor dependency — types are self-contained.
 */

import type { JsonObject } from "@koi/core";

export interface AtifDocument {
  readonly schema_version: "ATIF-v1.6";
  readonly session_id: string;
  readonly agent: AtifAgent;
  readonly steps: readonly AtifStep[];
  readonly notes?: string;
  readonly final_metrics?: AtifFinalMetrics;
  readonly extra?: JsonObject;
}

export interface AtifAgent {
  readonly name: string;
  readonly version?: string;
  readonly model_name?: string;
  readonly tool_definitions?: readonly AtifToolDefinition[];
  readonly extra?: JsonObject;
}

export interface AtifToolDefinition {
  readonly name: string;
  readonly description?: string;
  readonly parameters?: JsonObject;
}

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

export interface AtifToolCall {
  readonly tool_call_id: string;
  readonly function_name: string;
  readonly arguments?: JsonObject;
}

export interface AtifObservation {
  readonly results?: readonly AtifObservationResult[];
}

export interface AtifObservationResult {
  readonly source_call_id?: string;
  readonly content: string;
}

export interface AtifStepMetrics {
  readonly prompt_tokens?: number;
  readonly completion_tokens?: number;
  readonly cached_tokens?: number;
  readonly cost_usd?: number;
}

export interface AtifFinalMetrics {
  readonly total_prompt_tokens?: number;
  readonly total_completion_tokens?: number;
  readonly total_cached_tokens?: number;
  readonly total_cost_usd?: number;
  readonly total_steps?: number;
  readonly extra?: JsonObject;
}
