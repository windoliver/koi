/**
 * @koi/middleware-guardrails — Output validation middleware (Layer 2)
 *
 * Validates agent outputs against Zod schemas before delivery.
 * Prevents malformed responses, sensitive data leaks, and format violations.
 * Defense for OWASP LLM02 (Insecure Output Handling).
 *
 * Depends on @koi/core, @koi/errors, and zod only.
 */

export {
  DEFAULT_MAX_BUFFER_SIZE,
  DEFAULT_MAX_RETRY_ATTEMPTS,
  validateGuardrailsConfig,
} from "./config.js";
export { createGuardrailsMiddleware } from "./guardrails.js";
export type {
  GuardrailAction,
  GuardrailError,
  GuardrailParseMode,
  GuardrailRetryConfig,
  GuardrailRule,
  GuardrailsConfig,
  GuardrailTarget,
  GuardrailViolationEvent,
} from "./types.js";
export type { GuardrailValidationResult } from "./validate-output.js";
export { validateModelOutput, validateToolOutput } from "./validate-output.js";
