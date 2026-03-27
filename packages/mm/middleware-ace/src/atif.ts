/**
 * ATIF (Agent Trajectory Interchange Format) import/export.
 *
 * Maps between Koi's RichTrajectoryStep and ATIF v1.6 schema.
 * ATIF is used for debugging, replay, SFT, RL, and ecosystem interop.
 */

import type { JsonObject } from "@koi/core/common";
import type { RichContent, RichStepMetrics, RichTrajectoryStep } from "@koi/core/rich-trajectory";

// ---------------------------------------------------------------------------
// ATIF v1.6 types (snake_case per ATIF spec)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Export: RichTrajectoryStep[] → AtifDocument
// ---------------------------------------------------------------------------

const ATIF_SIZE_WARN_BYTES = 10_000_000;

/** Export options for ATIF document creation. */
export interface AtifExportOptions {
  readonly sessionId: string;
  readonly agentName: string;
  readonly agentVersion?: string;
  readonly notes?: string;
}

/** Convert Koi rich trajectory steps to an ATIF v1.6 document. */
export function mapRichTrajectoryToAtif(
  steps: readonly RichTrajectoryStep[],
  options: AtifExportOptions,
): AtifDocument {
  const atifSteps = steps.map(mapStepToAtif);

  const totalMetrics = computeFinalMetrics(steps);

  const doc: AtifDocument = {
    schema_version: "ATIF-v1.6",
    session_id: options.sessionId,
    agent: {
      name: options.agentName,
      ...(options.agentVersion !== undefined ? { version: options.agentVersion } : {}),
    },
    steps: atifSteps,
    ...(options.notes !== undefined ? { notes: options.notes } : {}),
    ...(totalMetrics !== undefined ? { final_metrics: totalMetrics } : {}),
  };

  // Size warning for large documents
  const serialized = JSON.stringify(doc);
  if (serialized.length > ATIF_SIZE_WARN_BYTES) {
    console.warn(
      `ATIF export: document is ${(serialized.length / 1_000_000).toFixed(1)}MB — consider filtering steps before export`,
    );
  }

  return doc;
}

function mapStepToAtif(step: RichTrajectoryStep): AtifStep {
  const atifStep: AtifStep = {
    step_id: step.stepIndex,
    source: step.source,
    timestamp: new Date(step.timestamp).toISOString(),
    ...(step.kind === "model_call" ? { model_name: step.identifier } : {}),
    ...(step.request?.text !== undefined ? { message: step.request.text } : {}),
    ...(step.reasoningContent !== undefined ? { reasoning_content: step.reasoningContent } : {}),
    ...(step.kind === "tool_call" ? mapToolCallToAtif(step) : {}),
    ...(step.metrics !== undefined ? { metrics: mapMetricsToAtif(step.metrics) } : {}),
    ...(step.metadata !== undefined ? { extra: step.metadata } : {}),
  };

  return atifStep;
}

function mapToolCallToAtif(step: RichTrajectoryStep): {
  readonly tool_calls: readonly AtifToolCall[];
  readonly observation?: AtifObservation;
} {
  const toolCall: AtifToolCall = {
    tool_call_id: `call_${step.identifier}_${step.stepIndex}`,
    function_name: step.identifier,
    ...(step.request?.data !== undefined ? { arguments: step.request.data } : {}),
  };

  const observation: AtifObservation | undefined =
    step.response?.text !== undefined
      ? {
          results: [
            {
              source_call_id: toolCall.tool_call_id,
              content: step.response.text,
            },
          ],
        }
      : undefined;

  return {
    tool_calls: [toolCall],
    ...(observation !== undefined ? { observation } : {}),
  };
}

function mapMetricsToAtif(metrics: RichStepMetrics): AtifStepMetrics {
  return {
    ...(metrics.promptTokens !== undefined ? { prompt_tokens: metrics.promptTokens } : {}),
    ...(metrics.completionTokens !== undefined
      ? { completion_tokens: metrics.completionTokens }
      : {}),
    ...(metrics.cachedTokens !== undefined ? { cached_tokens: metrics.cachedTokens } : {}),
    ...(metrics.costUsd !== undefined ? { cost_usd: metrics.costUsd } : {}),
  };
}

function computeFinalMetrics(steps: readonly RichTrajectoryStep[]): AtifFinalMetrics | undefined {
  const stepsWithMetrics = steps.filter((s) => s.metrics !== undefined);
  if (stepsWithMetrics.length === 0) return undefined;

  // let: mutable accumulators for summing metrics
  let totalPrompt = 0;
  let totalCompletion = 0;
  let totalCached = 0;
  let totalCost = 0;
  // let: tracks whether any non-zero values exist
  let hasPrompt = false;
  let hasCompletion = false;
  let hasCached = false;
  let hasCost = false;

  for (const step of stepsWithMetrics) {
    if (step.metrics?.promptTokens !== undefined) {
      totalPrompt += step.metrics.promptTokens;
      hasPrompt = true;
    }
    if (step.metrics?.completionTokens !== undefined) {
      totalCompletion += step.metrics.completionTokens;
      hasCompletion = true;
    }
    if (step.metrics?.cachedTokens !== undefined) {
      totalCached += step.metrics.cachedTokens;
      hasCached = true;
    }
    if (step.metrics?.costUsd !== undefined) {
      totalCost += step.metrics.costUsd;
      hasCost = true;
    }
  }

  return {
    ...(hasPrompt ? { total_prompt_tokens: totalPrompt } : {}),
    ...(hasCompletion ? { total_completion_tokens: totalCompletion } : {}),
    ...(hasCached ? { total_cached_tokens: totalCached } : {}),
    ...(hasCost ? { total_cost_usd: totalCost } : {}),
    total_steps: steps.length,
  };
}

// ---------------------------------------------------------------------------
// Import: AtifDocument → RichTrajectoryStep[]
// ---------------------------------------------------------------------------

/** Convert an ATIF v1.6 document to Koi rich trajectory steps. */
export function mapAtifToRichTrajectory(doc: AtifDocument): readonly RichTrajectoryStep[] {
  return doc.steps.map(mapAtifStepToRich);
}

function mapAtifStepToRich(step: AtifStep): RichTrajectoryStep {
  const kind = determineStepKind(step);
  const identifier = determineIdentifier(step, kind);
  const response = mapAtifResponse(step);

  return {
    stepIndex: step.step_id,
    timestamp: new Date(step.timestamp).getTime(),
    source: step.source,
    kind,
    identifier,
    outcome: determineOutcome(step),
    durationMs: 0, // ATIF does not capture duration directly
    ...(step.message !== undefined ? { request: { text: step.message } } : {}),
    ...(response !== undefined ? { response } : {}),
    ...(step.reasoning_content !== undefined ? { reasoningContent: step.reasoning_content } : {}),
    ...(step.metrics !== undefined ? { metrics: mapAtifMetricsToRich(step.metrics) } : {}),
    ...(step.extra !== undefined ? { metadata: step.extra } : {}),
  };
}

function determineStepKind(step: AtifStep): "model_call" | "tool_call" {
  if (step.tool_calls !== undefined && step.tool_calls.length > 0) return "tool_call";
  return "model_call";
}

function determineIdentifier(step: AtifStep, kind: "model_call" | "tool_call"): string {
  if (kind === "tool_call" && step.tool_calls !== undefined && step.tool_calls.length > 0) {
    const firstCall = step.tool_calls[0];
    return firstCall !== undefined ? firstCall.function_name : "unknown";
  }
  return step.model_name ?? "unknown";
}

function determineOutcome(step: AtifStep): "success" | "failure" | "retry" {
  // ATIF does not have explicit outcome — infer from observation
  if (step.observation?.results !== undefined && step.observation.results.length > 0) {
    return "success";
  }
  // For model calls, presence of a message implies success
  if (step.message !== undefined) return "success";
  return "failure";
}

function mapAtifResponse(step: AtifStep): RichContent | undefined {
  if (step.observation?.results !== undefined && step.observation.results.length > 0) {
    const firstResult = step.observation.results[0];
    if (firstResult !== undefined) {
      return { text: firstResult.content };
    }
  }
  return undefined;
}

function mapAtifMetricsToRich(metrics: AtifStepMetrics): RichStepMetrics {
  return {
    ...(metrics.prompt_tokens !== undefined ? { promptTokens: metrics.prompt_tokens } : {}),
    ...(metrics.completion_tokens !== undefined
      ? { completionTokens: metrics.completion_tokens }
      : {}),
    ...(metrics.cached_tokens !== undefined ? { cachedTokens: metrics.cached_tokens } : {}),
    ...(metrics.cost_usd !== undefined ? { costUsd: metrics.cost_usd } : {}),
  };
}
