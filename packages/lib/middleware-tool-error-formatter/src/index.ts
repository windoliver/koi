/**
 * @koi/middleware-tool-error-formatter — Format tool errors into actionable model feedback (L2)
 *
 * Catches tool errors via wrapToolCall, formats them into actionable messages,
 * and returns them as ToolResponse instead of throwing.
 * Depends on @koi/core and @koi/errors only.
 */

export {
  COMMITTED_PROVENANCE,
  createToolErrorFormatterMiddleware,
  GUARDRAIL_PROVENANCE,
  INTERNAL_PROVENANCE,
  type ToolErrorFormatterHandle,
} from "./formatter-middleware.js";
export type { ToolErrorFormatter, ToolErrorFormatterConfig } from "./types.js";
