/**
 * @koi/middleware-sanitize — Content sanitization middleware (Layer 2)
 *
 * Defense-in-depth content sanitization for model inputs, model outputs,
 * and tool I/O. Strips injection patterns, control characters, HTML tags,
 * and zero-width characters.
 * Depends on @koi/core and @koi/errors only.
 */

export type { SanitizeMiddlewareConfig } from "./config.js";
export {
  DEFAULT_JSON_WALK_MAX_DEPTH,
  DEFAULT_STREAM_BUFFER_SIZE,
  validateSanitizeConfig,
} from "./config.js";
export { descriptor } from "./descriptor.js";
export {
  CONTROL_CHAR_RULES,
  DEFAULT_RULES,
  HTML_TAG_RULES,
  PROMPT_INJECTION_RULES,
  resolvePresets,
  ZERO_WIDTH_RULES,
} from "./rules.js";
export { sanitizeBlock, sanitizeMessage, sanitizeString } from "./sanitize-block.js";
export { walkJsonStrings } from "./sanitize-json.js";
export { createSanitizeMiddleware } from "./sanitize-middleware.js";
export { createStreamBuffer, mapBlockToStrip } from "./stream-buffer.js";
export type {
  ContentBlockKind,
  RulePreset,
  SanitizationEvent,
  SanitizationLocation,
  SanitizeAction,
  SanitizeRule,
  SanitizeSeverity,
} from "./types.js";
