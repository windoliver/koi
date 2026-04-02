/**
 * ATIF (Agent Trajectory Interchange Format) v1.6 types.
 *
 * Independent TypeScript implementation of the Harbor framework ATIF spec.
 * Schema reference: https://github.com/harbor-framework/harbor/blob/main/docs/rfcs/0001-trajectory-format.md
 * Schema version: ATIF-v1.6
 * License: Apache-2.0
 *
 * Koi extensions to ATIF v1.6:
 *   - `duration_ms` on steps (step timing in milliseconds)
 *   - `outcome` on steps ("success" | "failure" | "retry")
 * Both stored as top-level fields per the spec's JSON extensibility.
 */

import type { JsonObject } from "@koi/core/common";

// ---------------------------------------------------------------------------
// Schema version
// ---------------------------------------------------------------------------

export const ATIF_SCHEMA_VERSION = "ATIF-v1.6" as const;

// ---------------------------------------------------------------------------
// Root document
// ---------------------------------------------------------------------------

/** ATIF root document. */
export interface AtifDocument {
  readonly schema_version: typeof ATIF_SCHEMA_VERSION;
  readonly session_id: string;
  readonly agent: AtifAgent;
  readonly steps: readonly AtifStep[];
  readonly notes?: string;
  readonly final_metrics?: AtifFinalMetrics;
  readonly extra?: JsonObject;
}

// ---------------------------------------------------------------------------
// Agent metadata
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Step types — discriminated union by `source`
// ---------------------------------------------------------------------------

/** Common fields shared by all ATIF step variants. */
interface AtifStepBase {
  readonly step_id: number;
  readonly timestamp: string;
  /** Duration of this step in milliseconds (Koi extension to ATIF v1.6). */
  readonly duration_ms?: number;
  /** Step outcome (Koi extension to ATIF v1.6). */
  readonly outcome?: "success" | "failure" | "retry";
  readonly metrics?: AtifStepMetrics;
  readonly extra?: JsonObject;
}

/** Agent step — a model call producing a message and optionally tool calls. */
export interface AtifAgentStep extends AtifStepBase {
  readonly source: "agent";
  readonly message?: string;
  readonly model_name?: string;
  readonly reasoning_content?: string;
  readonly tool_calls?: readonly AtifToolCall[];
  readonly observation?: AtifObservation;
}

/** Tool step — result of tool execution with observation. */
export interface AtifToolStep extends AtifStepBase {
  readonly source: "tool";
  readonly tool_calls: readonly AtifToolCall[];
  readonly observation?: AtifObservation;
}

/** User step — user-provided message. */
export interface AtifUserStep extends AtifStepBase {
  readonly source: "user";
  readonly message: string;
}

/** System step — system-level event or instruction. */
export interface AtifSystemStep extends AtifStepBase {
  readonly source: "system";
  readonly message: string;
}

/** Discriminated union of all ATIF step variants. */
export type AtifStep = AtifAgentStep | AtifToolStep | AtifUserStep | AtifSystemStep;

// ---------------------------------------------------------------------------
// Step components
// ---------------------------------------------------------------------------

/** ATIF tool call within a step. */
export interface AtifToolCall {
  readonly tool_call_id: string;
  readonly function_name: string;
  readonly arguments?: JsonObject;
}

/** ATIF observation — results of tool execution. */
export interface AtifObservation {
  readonly results?: readonly AtifObservationResult[];
}

/** ATIF observation result. */
export interface AtifObservationResult {
  readonly source_call_id?: string;
  readonly content: string;
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

/** ATIF per-step metrics. */
export interface AtifStepMetrics {
  readonly prompt_tokens?: number;
  readonly completion_tokens?: number;
  readonly cached_tokens?: number;
  readonly cost_usd?: number;
}

/** ATIF final (aggregate) metrics. */
export interface AtifFinalMetrics {
  readonly total_prompt_tokens?: number;
  readonly total_completion_tokens?: number;
  readonly total_cached_tokens?: number;
  readonly total_cost_usd?: number;
  readonly total_steps?: number;
  readonly extra?: JsonObject;
}

// ---------------------------------------------------------------------------
// Serialization types — flat optional-field shape for JSON I/O
// ---------------------------------------------------------------------------

/**
 * Flat ATIF step shape for JSON serialization/deserialization.
 * All variant-specific fields are optional — used only at the JSON boundary.
 * Internal code should use the discriminated `AtifStep` union.
 */
export interface AtifStepFlat {
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
