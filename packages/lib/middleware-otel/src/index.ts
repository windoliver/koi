// Middleware factory
export type { OtelHandle, OtelMiddlewareConfig } from "./middleware-otel.js";
export { createOtelMiddleware } from "./middleware-otel.js";
// Semantic convention constants (pinned to SEMCONV_GEN_AI_VERSION)
export {
  ATTR_GEN_AI_AGENT_NAME,
  ATTR_GEN_AI_OPERATION_NAME,
  ATTR_GEN_AI_PROVIDER_NAME,
  ATTR_GEN_AI_REQUEST_MAX_TOKENS,
  ATTR_GEN_AI_REQUEST_MODEL,
  ATTR_GEN_AI_REQUEST_TEMPERATURE,
  ATTR_GEN_AI_RESPONSE_FINISH_REASONS,
  ATTR_GEN_AI_RESPONSE_ID,
  ATTR_GEN_AI_RESPONSE_MODEL,
  ATTR_GEN_AI_TOOL_CALL_ID,
  ATTR_GEN_AI_TOOL_NAME,
  ATTR_GEN_AI_USAGE_INPUT_TOKENS,
  ATTR_GEN_AI_USAGE_OUTPUT_TOKENS,
  ATTR_KOI_SESSION_ID,
  ATTR_KOI_STEP_OUTCOME,
  EVENT_GEN_AI_CHOICE,
  EVENT_GEN_AI_USER_MESSAGE,
  GEN_AI_OPERATION_CHAT,
  GEN_AI_OPERATION_EXECUTE_TOOL,
  GEN_AI_OPERATION_INVOKE_AGENT,
  METRIC_KOI_GEN_AI_COST,
  SEMCONV_GEN_AI_VERSION,
} from "./semconv.js";
// Attribute builder utilities (useful for custom backends)
export {
  buildModelSpanAttrs,
  buildModelSpanName,
  buildSessionSpanAttrs,
  buildSessionSpanName,
  buildToolSpanAttrs,
  buildToolSpanName,
  extractProviderName,
} from "./span-attrs.js";
