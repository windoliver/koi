/**
 * Bidirectional mappers: RichTrajectoryStep ↔ AtifStep (ATIF-v1.6).
 *
 * Forward (Rich → ATIF): used for JSON export, VCR cassettes, debugging.
 * Reverse (ATIF → Rich): used for importing ATIF documents and round-trip testing.
 *
 * Lossy fields (documented for round-trip tests):
 *   - tool_call_id: generated synthetically in forward, ignored in reverse
 *   - outcome: when absent in ATIF, inferred heuristically in reverse
 *   - timestamp precision: Rich=Unix ms, ATIF=ISO 8601 (ms precision preserved)
 */

import type { JsonObject } from "@koi/core/common";
import type { RichContent, RichStepMetrics, RichTrajectoryStep } from "@koi/core/rich-trajectory";

import type {
  AtifAgentStep,
  AtifDocument,
  AtifFinalMetrics,
  AtifObservation,
  AtifStep,
  AtifStepFlat,
  AtifStepMetrics,
  AtifSystemStep,
  AtifToolCall,
  AtifToolStep,
} from "./atif-types.js";
import { ATIF_SCHEMA_VERSION } from "./atif-types.js";
import { pickDefined, sumOptional } from "./utils.js";

// ---------------------------------------------------------------------------
// Export options
// ---------------------------------------------------------------------------

/** Options for creating an ATIF document from rich trajectory steps. */
export interface AtifExportOptions {
  readonly sessionId: string;
  readonly agentName: string;
  readonly agentVersion?: string;
  readonly notes?: string;
}

// ---------------------------------------------------------------------------
// Forward: RichTrajectoryStep[] → AtifDocument
// ---------------------------------------------------------------------------

/** Convert Koi rich trajectory steps to an ATIF v1.6 document. */
export function mapRichTrajectoryToAtif(
  steps: readonly RichTrajectoryStep[],
  options: AtifExportOptions,
): AtifDocument {
  const atifSteps = steps.map(mapStepToAtif);
  const finalMetrics = computeFinalMetrics(steps);

  return {
    schema_version: ATIF_SCHEMA_VERSION,
    session_id: options.sessionId,
    agent: {
      name: options.agentName,
      ...pickDefined({ version: options.agentVersion }),
    },
    steps: atifSteps,
    ...pickDefined({
      notes: options.notes,
      final_metrics: finalMetrics,
    }),
  };
}

/** Map a single RichTrajectoryStep to a discriminated AtifStep. */
function mapStepToAtif(step: RichTrajectoryStep): AtifStep {
  // Merge error into extra (ATIF has no dedicated error field — use extra per spec)
  const extra =
    step.error !== undefined
      ? { ...(step.metadata ?? {}), error: { text: step.error.text, data: step.error.data } }
      : step.metadata;

  const optionalBase = pickDefined({
    duration_ms: step.durationMs,
    outcome: step.outcome,
    metrics: step.metrics !== undefined ? mapMetricsToAtif(step.metrics) : undefined,
    extra,
  });

  const stepId = step.stepIndex;
  const timestamp = new Date(step.timestamp).toISOString();

  switch (step.source) {
    case "agent": {
      const result: AtifAgentStep = {
        step_id: stepId,
        source: "agent",
        timestamp,
        ...optionalBase,
        ...pickDefined({
          message: step.request?.text,
          model_name: step.kind === "model_call" ? step.identifier : undefined,
          reasoning_content: step.reasoningContent,
          tool_calls: step.kind === "tool_call" ? [buildToolCall(step)] : undefined,
          observation: buildObservation(step),
        }),
      };
      return result;
    }
    case "tool": {
      const result: AtifToolStep = {
        step_id: stepId,
        source: "tool",
        timestamp,
        tool_calls: [buildToolCall(step)],
        ...optionalBase,
        ...pickDefined({
          observation: buildObservation(step),
        }),
      };
      return result;
    }
    case "user":
      return {
        step_id: stepId,
        source: "user",
        timestamp,
        message: step.request?.text ?? "",
        ...optionalBase,
      };
    case "system": {
      // Preserve non-default kind/identifier through ATIF round-trip (#1499).
      // Normal system steps (kind="model_call", identifier="system") need no extra fields.
      // Uses a single nested `__koi` object to avoid flat key collisions with user metadata.
      const hasNonDefaultKind = step.kind !== "model_call";
      const hasNonDefaultIdentifier = step.identifier !== "system";
      const koiTransport =
        hasNonDefaultKind || hasNonDefaultIdentifier
          ? {
              ...(hasNonDefaultKind ? { kind: step.kind } : {}),
              ...(hasNonDefaultIdentifier ? { identifier: step.identifier } : {}),
            }
          : undefined;
      const systemExtra =
        koiTransport !== undefined ? { ...(extra ?? {}), __koi: koiTransport } : extra;

      const systemOptionalBase = pickDefined({
        duration_ms: step.durationMs,
        outcome: step.outcome,
        metrics: step.metrics !== undefined ? mapMetricsToAtif(step.metrics) : undefined,
        extra: systemExtra,
      });

      return {
        step_id: stepId,
        source: "system",
        timestamp,
        message: step.request?.text ?? "",
        ...systemOptionalBase,
        ...pickDefined({ observation: buildObservation(step) }),
      };
    }
  }
}

function buildToolCall(step: RichTrajectoryStep): AtifToolCall {
  return {
    tool_call_id: `call_${step.identifier}_${String(step.stepIndex)}`,
    function_name: step.identifier,
    ...pickDefined({ arguments: step.request?.data }),
  };
}

function buildObservation(step: RichTrajectoryStep): AtifObservation | undefined {
  if (step.response?.text === undefined) return undefined;

  return {
    results: [
      {
        content: step.response.text,
        ...pickDefined({
          source_call_id:
            step.kind === "tool_call"
              ? `call_${step.identifier}_${String(step.stepIndex)}`
              : undefined,
        }),
      },
    ],
  };
}

function mapMetricsToAtif(metrics: RichStepMetrics): AtifStepMetrics {
  return pickDefined({
    prompt_tokens: metrics.promptTokens,
    completion_tokens: metrics.completionTokens,
    cached_tokens: metrics.cachedTokens,
    cost_usd: metrics.costUsd,
  }) as AtifStepMetrics;
}

/** Compute aggregate final metrics from all steps using sumOptional. */
export function computeFinalMetrics(
  steps: readonly RichTrajectoryStep[],
): AtifFinalMetrics | undefined {
  const withMetrics = steps.filter((s) => s.metrics !== undefined);
  if (withMetrics.length === 0) return undefined;

  return {
    total_steps: steps.length,
    ...pickDefined({
      total_prompt_tokens: sumOptional(withMetrics, (s) => s.metrics?.promptTokens),
      total_completion_tokens: sumOptional(withMetrics, (s) => s.metrics?.completionTokens),
      total_cached_tokens: sumOptional(withMetrics, (s) => s.metrics?.cachedTokens),
      total_cost_usd: sumOptional(withMetrics, (s) => s.metrics?.costUsd),
    }),
  };
}

// ---------------------------------------------------------------------------
// Reverse: AtifDocument → RichTrajectoryStep[]
// ---------------------------------------------------------------------------

/** Convert an ATIF v1.6 document to Koi rich trajectory steps. */
export function mapAtifToRichTrajectory(doc: AtifDocument): readonly RichTrajectoryStep[] {
  return doc.steps.map(mapAtifStepToRich);
}

/** Map a discriminated AtifStep to a RichTrajectoryStep. */
function mapAtifStepToRich(step: AtifStep): RichTrajectoryStep {
  // Extract error from extra (reverse of forward mapping)
  const rawExtra = step.extra as Record<string, unknown> | undefined;
  const hasError = rawExtra !== undefined && Object.hasOwn(rawExtra, "error");
  const errorData = hasError
    ? (rawExtra.error as { text?: string; data?: Record<string, unknown> } | undefined)
    : undefined;
  // Strip error from metadata so it doesn't duplicate
  const cleanedExtra = hasError
    ? (Object.fromEntries(Object.entries(rawExtra).filter(([k]) => k !== "error")) as JsonObject)
    : step.extra;

  const optionalBase = pickDefined({
    metrics: step.metrics !== undefined ? mapAtifMetricsToRich(step.metrics) : undefined,
    metadata: Object.keys(cleanedExtra ?? {}).length > 0 ? cleanedExtra : undefined,
    error:
      errorData !== undefined
        ? ({ text: errorData.text, data: errorData.data } as RichContent)
        : undefined,
  });

  const common = {
    stepIndex: step.step_id,
    timestamp: new Date(step.timestamp).getTime(),
    durationMs: step.duration_ms ?? 0,
    ...optionalBase,
  };

  switch (step.source) {
    case "agent":
      return {
        ...common,
        source: "agent",
        kind: inferKind(step),
        identifier: inferAgentIdentifier(step),
        outcome: step.outcome ?? inferOutcomeFromAgentOrTool(step),
        ...pickDefined({
          request: step.message !== undefined ? ({ text: step.message } as RichContent) : undefined,
          response: extractObservationResponse(step),
          reasoningContent: step.reasoning_content,
        }),
      };
    case "tool": {
      // Rebuild request.data from tool_calls[].arguments (preserves tool args in round-trip)
      const firstToolCall = step.tool_calls[0];
      const toolRequest =
        firstToolCall?.arguments !== undefined
          ? ({ data: firstToolCall.arguments } as RichContent)
          : undefined;

      return {
        ...common,
        source: "tool",
        kind: "tool_call",
        identifier: inferToolIdentifier(step),
        outcome: step.outcome ?? inferOutcomeFromAgentOrTool(step),
        ...pickDefined({
          request: toolRequest,
          response: extractObservationResponse(step),
        }),
      };
    }
    case "user":
      return {
        ...common,
        source: "user",
        kind: "model_call",
        identifier: "user",
        outcome: step.outcome ?? "success",
        request: { text: step.message },
      };
    case "system": {
      // Recover non-default kind/identifier from nested __koi transport object (#1499).
      const sysExtra = step.extra as Record<string, unknown> | undefined;
      const koiTransport =
        sysExtra !== undefined && Object.hasOwn(sysExtra, "__koi")
          ? (sysExtra.__koi as Record<string, unknown>)
          : undefined;
      const recoveredKind =
        koiTransport?.kind === "tool_call" ? ("tool_call" as const) : ("model_call" as const);
      const recoveredIdentifier =
        typeof koiTransport?.identifier === "string" ? koiTransport.identifier : "system";

      // Strip __koi transport object AND error (already extracted above) from metadata.
      const strippedMeta =
        sysExtra !== undefined
          ? (Object.fromEntries(
              Object.entries(sysExtra).filter(([k]) => k !== "__koi" && k !== "error"),
            ) as JsonObject)
          : undefined;
      const systemBase = pickDefined({
        metrics: step.metrics !== undefined ? mapAtifMetricsToRich(step.metrics) : undefined,
        metadata: Object.keys(strippedMeta ?? {}).length > 0 ? strippedMeta : undefined,
        error:
          errorData !== undefined
            ? ({ text: errorData.text, data: errorData.data } as RichContent)
            : undefined,
      });

      return {
        stepIndex: step.step_id,
        timestamp: new Date(step.timestamp).getTime(),
        durationMs: step.duration_ms ?? 0,
        ...systemBase,
        source: "system",
        kind: recoveredKind,
        identifier: recoveredIdentifier,
        outcome: step.outcome ?? "success",
        ...pickDefined({
          request: step.message !== undefined ? ({ text: step.message } as RichContent) : undefined,
          response: extractObservationResponse(step),
        }),
      };
    }
  }
}

function inferKind(step: AtifAgentStep): "model_call" | "tool_call" {
  if (step.tool_calls !== undefined && step.tool_calls.length > 0) return "tool_call";
  return "model_call";
}

function inferAgentIdentifier(step: AtifAgentStep): string {
  if (step.tool_calls !== undefined && step.tool_calls.length > 0) {
    const firstCall = step.tool_calls[0];
    return firstCall !== undefined ? firstCall.function_name : "unknown";
  }
  return step.model_name ?? "unknown";
}

function inferToolIdentifier(step: AtifToolStep): string {
  const firstCall = step.tool_calls[0];
  return firstCall !== undefined ? firstCall.function_name : "unknown";
}

/**
 * Infer outcome when not explicitly present in the ATIF step.
 * Only called for agent and tool steps (which have observation).
 *
 * NOTE: This is a lossy heuristic — round-trip tests should always
 * set `outcome` explicitly to avoid data corruption.
 */
function inferOutcomeFromAgentOrTool(
  step: AtifAgentStep | AtifToolStep,
): "success" | "failure" | "retry" {
  if (step.observation?.results !== undefined && step.observation.results.length > 0) {
    return "success";
  }
  if ("message" in step && step.message !== undefined) return "success";
  return "failure";
}

function extractObservationResponse(
  step: AtifAgentStep | AtifToolStep | AtifSystemStep,
): RichContent | undefined {
  if (step.observation?.results !== undefined && step.observation.results.length > 0) {
    const firstResult = step.observation.results[0];
    if (firstResult !== undefined) {
      return { text: firstResult.content };
    }
  }
  return undefined;
}

function mapAtifMetricsToRich(metrics: AtifStepMetrics): RichStepMetrics {
  return pickDefined({
    promptTokens: metrics.prompt_tokens,
    completionTokens: metrics.completion_tokens,
    cachedTokens: metrics.cached_tokens,
    costUsd: metrics.cost_usd,
  }) as RichStepMetrics;
}

// ---------------------------------------------------------------------------
// Flat serialization helpers
// ---------------------------------------------------------------------------

/** Convert a discriminated AtifStep to a flat shape for JSON output. */
export function flattenStep(step: AtifStep): AtifStepFlat {
  return step as AtifStepFlat;
}

/** Parse a flat ATIF step (from JSON) into the discriminated union. */
export function parseStep(flat: AtifStepFlat): AtifStep {
  switch (flat.source) {
    case "agent":
      return {
        step_id: flat.step_id,
        source: "agent",
        timestamp: flat.timestamp,
        ...pickDefined({
          message: flat.message,
          model_name: flat.model_name,
          reasoning_content: flat.reasoning_content,
          tool_calls: flat.tool_calls,
          observation: flat.observation,
          metrics: flat.metrics,
          duration_ms: flat.duration_ms,
          outcome: flat.outcome,
          extra: flat.extra,
        }),
      };
    case "tool":
      return {
        step_id: flat.step_id,
        source: "tool",
        timestamp: flat.timestamp,
        tool_calls: flat.tool_calls ?? [],
        ...pickDefined({
          observation: flat.observation,
          metrics: flat.metrics,
          duration_ms: flat.duration_ms,
          outcome: flat.outcome,
          extra: flat.extra,
        }),
      };
    case "user":
      return {
        step_id: flat.step_id,
        source: "user",
        timestamp: flat.timestamp,
        message: flat.message ?? "",
        ...pickDefined({
          metrics: flat.metrics,
          duration_ms: flat.duration_ms,
          outcome: flat.outcome,
          extra: flat.extra,
        }),
      };
    case "system":
      return {
        step_id: flat.step_id,
        source: "system",
        timestamp: flat.timestamp,
        message: flat.message ?? "",
        ...pickDefined({
          metrics: flat.metrics,
          duration_ms: flat.duration_ms,
          outcome: flat.outcome,
          extra: flat.extra,
          observation: flat.observation,
        }),
      };
  }
}
