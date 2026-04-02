import type { RichStepMetrics, RichTrajectoryStep } from "@koi/core";
import { parseStep } from "./atif-mappers.js";
import type {
  AtifDocument,
  AtifFinalMetrics,
  AtifObservation,
  AtifObservationResult,
  AtifStepFlat,
  AtifStepMetrics,
  AtifToolCall,
} from "./atif-types.js";
import { ATIF_SCHEMA_VERSION } from "./atif-types.js";

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface AtifDocumentOptions {
  readonly sessionId: string;
  readonly agentName: string;
  readonly agentVersion?: string;
  readonly modelName?: string;
}

// ---------------------------------------------------------------------------
// Helper: omit undefined values from an object (satisfies exactOptionalPropertyTypes)
// ---------------------------------------------------------------------------

function omitUndefined<T>(obj: Record<string, unknown>): T {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value !== undefined) {
      result[key] = value;
    }
  }
  return result as T;
}

// ---------------------------------------------------------------------------
// Rich → ATIF
// ---------------------------------------------------------------------------

export function mapRichStepToAtif(step: RichTrajectoryStep): AtifStepFlat {
  const toolCalls: readonly AtifToolCall[] | undefined =
    step.kind === "tool_call"
      ? [
          omitUndefined<AtifToolCall>({
            tool_call_id: step.bulletIds?.[0] ?? `call-${String(step.stepIndex)}`,
            function_name: step.identifier,
            arguments: step.request?.data,
          }),
        ]
      : undefined;

  const observation: AtifObservation | undefined =
    step.response?.text !== undefined
      ? {
          results: [
            omitUndefined<AtifObservationResult>({
              source_call_id: toolCalls?.[0]?.tool_call_id,
              content: step.response.text,
            }),
          ],
        }
      : undefined;

  return omitUndefined<AtifStepFlat>({
    step_id: step.stepIndex,
    source: step.source,
    timestamp: new Date(step.timestamp).toISOString(),
    message: step.kind === "model_call" ? step.request?.text : undefined,
    model_name: step.kind === "model_call" ? step.identifier : undefined,
    reasoning_content: step.reasoningContent,
    tool_calls: toolCalls,
    observation,
    metrics: step.metrics ? mapMetricsToAtif(step.metrics) : undefined,
    duration_ms: step.durationMs,
    outcome: step.outcome,
    extra: step.metadata,
  });
}

function mapMetricsToAtif(m: RichStepMetrics): AtifStepMetrics {
  return omitUndefined<AtifStepMetrics>({
    prompt_tokens: m.promptTokens,
    completion_tokens: m.completionTokens,
    cached_tokens: m.cachedTokens,
    cost_usd: m.costUsd,
  });
}

export function mapRichToAtifDocument(
  steps: readonly RichTrajectoryStep[],
  options: AtifDocumentOptions,
): AtifDocument {
  return {
    schema_version: ATIF_SCHEMA_VERSION,
    session_id: options.sessionId,
    agent: omitUndefined<AtifDocument["agent"]>({
      name: options.agentName,
      version: options.agentVersion,
      model_name: options.modelName,
    }),
    steps: steps.map((s) => parseStep(mapRichStepToAtif(s))),
    final_metrics: computeFinalMetrics(steps),
  };
}

export function computeFinalMetrics(steps: readonly RichTrajectoryStep[]): AtifFinalMetrics {
  let totalPrompt = 0;
  let totalCompletion = 0;
  let totalCached = 0;
  let totalCost = 0;

  for (const step of steps) {
    if (step.metrics) {
      totalPrompt += step.metrics.promptTokens ?? 0;
      totalCompletion += step.metrics.completionTokens ?? 0;
      totalCached += step.metrics.cachedTokens ?? 0;
      totalCost += step.metrics.costUsd ?? 0;
    }
  }

  return {
    total_prompt_tokens: totalPrompt,
    total_completion_tokens: totalCompletion,
    total_cached_tokens: totalCached,
    total_cost_usd: totalCost,
    total_steps: steps.length,
  };
}

// ---------------------------------------------------------------------------
// ATIF → Rich
// ---------------------------------------------------------------------------

export function mapAtifStepToRich(step: AtifStepFlat): RichTrajectoryStep {
  const kind = step.tool_calls && step.tool_calls.length > 0 ? "tool_call" : "model_call";
  const identifier =
    kind === "tool_call"
      ? (step.tool_calls?.[0]?.function_name ?? "unknown")
      : (step.model_name ?? "unknown");

  const responseText = step.observation?.results?.[0]?.content;

  return omitUndefined<RichTrajectoryStep>({
    stepIndex: step.step_id,
    timestamp: new Date(step.timestamp).getTime(),
    source: step.source,
    kind,
    identifier,
    outcome: step.outcome ?? (responseText !== undefined ? "success" : "failure"),
    durationMs: step.duration_ms ?? 0,
    request: step.message !== undefined ? { text: step.message } : undefined,
    response: responseText !== undefined ? { text: responseText } : undefined,
    reasoningContent: step.reasoning_content,
    metrics: step.metrics ? mapAtifMetricsToRich(step.metrics) : undefined,
    metadata: step.extra,
  });
}

function mapAtifMetricsToRich(m: AtifStepMetrics): RichStepMetrics {
  return omitUndefined<RichStepMetrics>({
    promptTokens: m.prompt_tokens,
    completionTokens: m.completion_tokens,
    cachedTokens: m.cached_tokens,
    costUsd: m.cost_usd,
  });
}

export function mapAtifDocumentToRich(doc: AtifDocument): readonly RichTrajectoryStep[] {
  // AtifStep (discriminated union) is structurally compatible with AtifStepFlat
  return doc.steps.map((step) => mapAtifStepToRich(step));
}
