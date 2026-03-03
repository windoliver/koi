/**
 * OpenTelemetry semantic convention attribute names for GenAI and Koi.
 *
 * GenAI conventions follow the OpenTelemetry GenAI semantic conventions spec.
 * Koi-specific attributes use the `koi.` namespace prefix.
 */

// --- GenAI semantic conventions ---
export const GEN_AI_OPERATION_NAME = "gen_ai.operation.name" as const;
export const GEN_AI_SYSTEM = "gen_ai.system" as const;
export const GEN_AI_REQUEST_MODEL = "gen_ai.request.model" as const;
export const GEN_AI_REQUEST_TEMPERATURE = "gen_ai.request.temperature" as const;
export const GEN_AI_REQUEST_MAX_TOKENS = "gen_ai.request.max_tokens" as const;
export const GEN_AI_RESPONSE_MODEL = "gen_ai.response.model" as const;
export const GEN_AI_RESPONSE_FINISH_REASON = "gen_ai.response.finish_reason" as const;
export const GEN_AI_USAGE_INPUT_TOKENS = "gen_ai.usage.input_tokens" as const;
export const GEN_AI_USAGE_OUTPUT_TOKENS = "gen_ai.usage.output_tokens" as const;

// --- Koi-specific attributes ---
export const KOI_SESSION_ID = "koi.session.id" as const;
export const KOI_AGENT_ID = "koi.agent.id" as const;
export const KOI_TURN_INDEX = "koi.turn.index" as const;
export const KOI_TOOL_ID = "koi.tool.id" as const;
export const KOI_MIDDLEWARE_NAME = "koi.middleware.name" as const;
export const KOI_REQUEST_CONTENT = "koi.request.content" as const;
export const KOI_RESPONSE_CONTENT = "koi.response.content" as const;
export const KOI_COST_USD = "koi.cost.usd" as const;
