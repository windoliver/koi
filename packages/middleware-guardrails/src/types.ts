/**
 * Type definitions for @koi/middleware-guardrails.
 *
 * Defines guardrail rules, config, and violation events for
 * Zod-based output validation of model and tool responses.
 */

import type { z } from "zod";

/** Target of a guardrail rule — which output to validate. */
export type GuardrailTarget = "modelOutput" | "toolOutput";

/** Action to take when validation fails. */
export type GuardrailAction = "block" | "warn" | "retry";

/** How to parse model output content before schema validation. */
export type GuardrailParseMode = "json" | "text";

/** A single guardrail rule binding a Zod schema to an output target. */
export interface GuardrailRule {
  /** Human-readable rule name (unique within a config). */
  readonly name: string;
  /** Zod schema to validate the output against. */
  readonly schema: z.ZodType;
  /** Which output this rule applies to. */
  readonly target: GuardrailTarget;
  /** What to do when the output fails validation. */
  readonly action: GuardrailAction;
  /** How to parse model output content (default: "json"). Ignored for toolOutput. */
  readonly parseMode?: GuardrailParseMode | undefined;
}

/** Retry configuration for rules with action "retry". */
export interface GuardrailRetryConfig {
  /** Maximum number of retry attempts (default: 2). */
  readonly maxAttempts?: number | undefined;
}

/** Full middleware configuration. */
export interface GuardrailsConfig {
  /** Guardrail rules to enforce. Must be non-empty. */
  readonly rules: readonly GuardrailRule[];
  /** Retry settings for rules with action "retry". */
  readonly retry?: GuardrailRetryConfig | undefined;
  /** Max characters to buffer for streaming validation (default: 262144). */
  readonly maxBufferSize?: number | undefined;
  /** Called whenever a rule violation is detected. */
  readonly onViolation?: ((event: GuardrailViolationEvent) => void) | undefined;
}

/** Event fired when a guardrail rule detects a violation. */
export interface GuardrailViolationEvent {
  /** Name of the rule that was violated. */
  readonly rule: string;
  /** Which output the violation was detected in. */
  readonly target: GuardrailTarget;
  /** Action taken (or to be taken) for this violation. */
  readonly action: GuardrailAction;
  /** Zod validation errors. */
  readonly errors: readonly GuardrailError[];
  /** Current retry attempt (1-indexed), present when action is "retry". */
  readonly attempt?: number | undefined;
}

/** A single validation error detail from Zod. */
export interface GuardrailError {
  /** Dot-separated path to the failing field (empty string for root). */
  readonly path: string;
  /** Human-readable error message. */
  readonly message: string;
  /** Zod issue code. */
  readonly code: string;
}
