/**
 * Bidirectional mapping between Koi's RichTrajectoryStep and ATIF v1.6.
 * Ported from archive/v1/packages/mm/middleware-ace/src/atif.ts.
 */

import type { RichContent, RichStepMetrics, RichTrajectoryStep } from "@koi/core";
import type {
  AtifDocument,
  AtifFinalMetrics,
  AtifObservation,
  AtifStep,
  AtifStepMetrics,
  AtifToolCall,
} from "./atif-types.js";

// ---------------------------------------------------------------------------
// Export: RichTrajectoryStep[] → AtifDocument
// ---------------------------------------------------------------------------

export interface AtifExportOptions {
  readonly sessionId: string;
  readonly agentName: string;
  readonly agentVersion?: string;
  readonly notes?: string;
}

export function mapRichTrajectoryToAtif(
  steps: readonly RichTrajectoryStep[],
  options: AtifExportOptions,
): AtifDocument {
  const atifSteps = steps.map(mapStepToAtif);
  const totalMetrics = computeFinalMetrics(steps);

  return {
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
}

function mapStepToAtif(step: RichTrajectoryStep): AtifStep {
  // Preserve non-default kind/identifier for system steps through ATIF round-trip (#1499).
  const hasNonDefaultSystemFields =
    step.source === "system" && (step.kind !== "model_call" || step.identifier !== "system");
  const koiTransport = hasNonDefaultSystemFields
    ? {
        ...(step.kind !== "model_call" ? { kind: step.kind } : {}),
        ...(step.identifier !== "system" ? { identifier: step.identifier } : {}),
      }
    : undefined;
  const extra =
    koiTransport !== undefined ? { ...(step.metadata ?? {}), __koi: koiTransport } : step.metadata;

  return {
    step_id: step.stepIndex,
    source: step.source,
    timestamp: new Date(step.timestamp).toISOString(),
    ...(step.kind === "model_call" ? { model_name: step.identifier } : {}),
    ...(step.request?.text !== undefined ? { message: step.request.text } : {}),
    ...(step.reasoningContent !== undefined ? { reasoning_content: step.reasoningContent } : {}),
    ...(step.kind === "tool_call" ? mapToolCallToAtif(step) : {}),
    ...(step.kind === "model_call" && step.response?.text !== undefined
      ? { observation: { results: [{ content: step.response.text }] } }
      : {}),
    ...(step.metrics !== undefined ? { metrics: mapMetricsToAtif(step.metrics) } : {}),
    duration_ms: step.durationMs,
    outcome: step.outcome,
    ...(extra !== undefined ? { extra } : {}),
  };
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
      ? { results: [{ source_call_id: toolCall.tool_call_id, content: step.response.text }] }
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

  // let: mutable accumulators for summing
  let totalPrompt = 0;
  let totalCompletion = 0;
  let totalCached = 0;
  let totalCost = 0;
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

export function mapAtifToRichTrajectory(doc: AtifDocument): readonly RichTrajectoryStep[] {
  return doc.steps.map(mapAtifStepToRich);
}

function mapAtifStepToRich(step: AtifStep): RichTrajectoryStep {
  // Recover non-default kind/identifier from nested __koi transport object (#1499).
  const rawExtra = step.extra as Record<string, unknown> | undefined;
  const koiTransport =
    step.source === "system" && rawExtra !== undefined && Object.hasOwn(rawExtra, "__koi")
      ? (rawExtra.__koi as Record<string, unknown>)
      : undefined;

  const kind =
    koiTransport !== undefined
      ? koiTransport.kind === "tool_call"
        ? "tool_call"
        : "model_call"
      : step.tool_calls !== undefined && step.tool_calls.length > 0
        ? "tool_call"
        : "model_call";
  const identifier =
    koiTransport !== undefined
      ? typeof koiTransport.identifier === "string"
        ? koiTransport.identifier
        : "system"
      : kind === "tool_call" && step.tool_calls !== undefined && step.tool_calls.length > 0
        ? (step.tool_calls[0]?.function_name ?? "unknown")
        : (step.model_name ?? "unknown");
  const response = mapAtifResponse(step);

  // Strip __koi transport object from metadata.
  // When koiTransport is defined, rawExtra is guaranteed non-undefined (see guard above).
  const cleanedExtra =
    koiTransport !== undefined && rawExtra !== undefined
      ? Object.fromEntries(Object.entries(rawExtra).filter(([k]) => k !== "__koi"))
      : step.extra;
  const metadata =
    cleanedExtra !== undefined && Object.keys(cleanedExtra).length > 0 ? cleanedExtra : undefined;

  // Build request: text from message, structured data from tool_calls arguments
  const toolArgs =
    kind === "tool_call" && step.tool_calls !== undefined && step.tool_calls.length > 0
      ? step.tool_calls[0]?.arguments
      : undefined;
  const request =
    step.message !== undefined || toolArgs !== undefined
      ? {
          ...(step.message !== undefined ? { text: step.message } : {}),
          ...(toolArgs !== undefined ? { data: toolArgs } : {}),
        }
      : undefined;

  return {
    stepIndex: step.step_id,
    timestamp: new Date(step.timestamp).getTime(),
    source: step.source,
    kind,
    identifier,
    outcome: step.outcome ?? inferOutcome(step),
    durationMs: step.duration_ms ?? 0,
    ...(request !== undefined ? { request } : {}),
    ...(response !== undefined ? { response } : {}),
    ...(step.reasoning_content !== undefined ? { reasoningContent: step.reasoning_content } : {}),
    ...(step.metrics !== undefined ? { metrics: mapAtifMetricsToRich(step.metrics) } : {}),
    ...(metadata !== undefined ? { metadata } : {}),
  };
}

function inferOutcome(step: AtifStep): "success" | "failure" | "retry" {
  if (step.observation?.results !== undefined && step.observation.results.length > 0)
    return "success";
  if (step.message !== undefined) return "success";
  return "failure";
}

function mapAtifResponse(step: AtifStep): RichContent | undefined {
  const firstResult = step.observation?.results?.[0];
  return firstResult !== undefined ? { text: firstResult.content } : undefined;
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
