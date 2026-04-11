/**
 * Pure functions: RichTrajectoryStep → OTel SpanAttributes.
 *
 * All logic for mapping Koi step data to OTel attribute objects lives here.
 * No side effects, no OTel API calls — fully unit-testable without mocks.
 */

import type { RichTrajectoryStep } from "@koi/core/rich-trajectory";
import type { SpanAttributes } from "@opentelemetry/api";
import {
  ATTR_GEN_AI_AGENT_NAME,
  ATTR_GEN_AI_OPERATION_NAME,
  ATTR_GEN_AI_PROVIDER_NAME,
  ATTR_GEN_AI_REQUEST_MAX_TOKENS,
  ATTR_GEN_AI_REQUEST_MODEL,
  ATTR_GEN_AI_REQUEST_TEMPERATURE,
  ATTR_GEN_AI_RESPONSE_FINISH_REASONS,
  ATTR_GEN_AI_RESPONSE_MODEL,
  ATTR_GEN_AI_TOOL_CALL_ID,
  ATTR_GEN_AI_TOOL_NAME,
  ATTR_GEN_AI_USAGE_INPUT_TOKENS,
  ATTR_GEN_AI_USAGE_OUTPUT_TOKENS,
  ATTR_KOI_SESSION_ID,
  ATTR_KOI_STEP_OUTCOME,
  GEN_AI_OPERATION_CHAT,
  GEN_AI_OPERATION_EXECUTE_TOOL,
  GEN_AI_OPERATION_INVOKE_AGENT,
} from "./semconv.js";

// ---------------------------------------------------------------------------
// Provider inference
// ---------------------------------------------------------------------------

/**
 * Infer the OTel gen_ai.provider.name from a model identifier string.
 * Best-effort: unknown models return "unknown".
 */
export function extractProviderName(modelId: string): string {
  if (
    modelId.startsWith("gpt-") ||
    modelId.startsWith("o1") ||
    modelId.startsWith("o3") ||
    modelId.startsWith("o4")
  )
    return "openai";
  if (modelId.startsWith("claude-")) return "anthropic";
  if (modelId.startsWith("gemini-")) return "google";
  if (modelId.startsWith("mistral-") || modelId.startsWith("mixtral-")) return "mistral";
  if (modelId.startsWith("llama-") || modelId.startsWith("meta-llama")) return "meta";
  if (modelId.startsWith("command-")) return "cohere";
  return "unknown";
}

// ---------------------------------------------------------------------------
// Span name builders
// ---------------------------------------------------------------------------

/**
 * OTel span name for a model call step.
 * Format: "chat {model}" per GenAI semantic conventions.
 */
export function buildModelSpanName(step: RichTrajectoryStep): string {
  return `${GEN_AI_OPERATION_CHAT} ${step.identifier}`;
}

/**
 * OTel span name for a tool call step.
 * Format: "execute_tool {tool}" per GenAI semantic conventions.
 */
export function buildToolSpanName(step: RichTrajectoryStep): string {
  return `${GEN_AI_OPERATION_EXECUTE_TOOL} ${step.identifier}`;
}

/**
 * OTel span name for a session root span.
 * Format: "invoke_agent {agentName}" per GenAI agent conventions.
 */
export function buildSessionSpanName(agentName: string): string {
  return `${GEN_AI_OPERATION_INVOKE_AGENT} ${agentName}`;
}

// ---------------------------------------------------------------------------
// Attribute builders
// ---------------------------------------------------------------------------

/**
 * Build OTel span attributes for a model call step.
 *
 * Reads well-known metadata keys from RichTrajectoryStep.metadata:
 *   - requestModel, temperature, maxTokens (from EventTraceConfig extractModelRequestMetadata)
 *   - responseModel, modelStopReason (from extractResponseMetadata)
 *
 * Returns a plain object — call span.setAttributes(result) once per span.
 */
export function buildModelSpanAttrs(step: RichTrajectoryStep, sessionId: string): SpanAttributes {
  const attrs: Record<string, string | number | string[]> = {
    [ATTR_GEN_AI_OPERATION_NAME]: GEN_AI_OPERATION_CHAT,
    [ATTR_GEN_AI_PROVIDER_NAME]: extractProviderName(step.identifier),
    [ATTR_KOI_SESSION_ID]: sessionId,
    [ATTR_KOI_STEP_OUTCOME]: step.outcome,
  };

  // Response model (actual model that served, from step identifier)
  if (step.identifier !== "unknown") {
    attrs[ATTR_GEN_AI_RESPONSE_MODEL] = step.identifier;
  }

  // Metadata fields set by event-trace extractModelRequestMetadata / extractResponseMetadata
  const meta = step.metadata as Record<string, unknown> | undefined;
  if (meta !== undefined) {
    if (typeof meta.requestModel === "string") {
      attrs[ATTR_GEN_AI_REQUEST_MODEL] = meta.requestModel;
    }
    if (typeof meta.temperature === "number") {
      attrs[ATTR_GEN_AI_REQUEST_TEMPERATURE] = meta.temperature;
    }
    if (typeof meta.maxTokens === "number") {
      attrs[ATTR_GEN_AI_REQUEST_MAX_TOKENS] = meta.maxTokens;
    }
    if (typeof meta.responseModel === "string") {
      // Prefer explicit responseModel metadata over identifier
      attrs[ATTR_GEN_AI_RESPONSE_MODEL] = meta.responseModel;
    }
    if (typeof meta.modelStopReason === "string") {
      attrs[ATTR_GEN_AI_RESPONSE_FINISH_REASONS] = [meta.modelStopReason];
    }
  }

  // Token usage from step metrics
  if (step.metrics !== undefined) {
    if (step.metrics.promptTokens !== undefined) {
      attrs[ATTR_GEN_AI_USAGE_INPUT_TOKENS] = step.metrics.promptTokens;
    }
    if (step.metrics.completionTokens !== undefined) {
      attrs[ATTR_GEN_AI_USAGE_OUTPUT_TOKENS] = step.metrics.completionTokens;
    }
  }

  return attrs;
}

/**
 * Build OTel span attributes for a tool call step.
 *
 * Returns a plain object — call span.setAttributes(result) once per span.
 */
export function buildToolSpanAttrs(step: RichTrajectoryStep, sessionId: string): SpanAttributes {
  const attrs: Record<string, string | number | string[]> = {
    [ATTR_GEN_AI_OPERATION_NAME]: GEN_AI_OPERATION_EXECUTE_TOOL,
    [ATTR_GEN_AI_TOOL_NAME]: step.identifier,
    [ATTR_KOI_SESSION_ID]: sessionId,
    [ATTR_KOI_STEP_OUTCOME]: step.outcome,
  };

  // Tool call correlation ID (set by permissions middleware on denial steps)
  const meta = step.metadata as Record<string, unknown> | undefined;
  if (meta !== undefined && typeof meta.decisionCorrelationId === "string") {
    attrs[ATTR_GEN_AI_TOOL_CALL_ID] = meta.decisionCorrelationId;
  }

  return attrs;
}

/**
 * Build OTel span attributes for the root session span.
 */
export function buildSessionSpanAttrs(agentId: string, sessionId: string): SpanAttributes {
  return {
    [ATTR_GEN_AI_OPERATION_NAME]: GEN_AI_OPERATION_INVOKE_AGENT,
    [ATTR_GEN_AI_AGENT_NAME]: agentId,
    [ATTR_KOI_SESSION_ID]: sessionId,
  };
}
