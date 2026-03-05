/**
 * BrickDescriptor for @koi/middleware-event-rules.
 *
 * Enables manifest auto-resolution: validates event rules options
 * from koi.yaml, then creates the event-rules middleware.
 *
 * Usage in koi.yaml:
 *   middleware:
 *     - name: event-rules
 *       options:
 *         rules:
 *           - name: tool-failure-escalate
 *             on: tool_call
 *             match:
 *               ok: false
 *             condition:
 *               count: 3
 *               window: "1m"
 *             actions:
 *               - type: escalate
 *                 message: "Tool {{toolId}} failed {{count}} times"
 */

import type { KoiError, KoiMiddleware, Result } from "@koi/core";
import { RETRYABLE_DEFAULTS } from "@koi/core/errors";
import type { BrickDescriptor } from "@koi/resolve";
import { createEventRulesMiddleware } from "./rule-middleware.js";
import { validateEventRulesConfig } from "./rule-schema.js";

function descriptorValidationError(message: string): {
  readonly ok: false;
  readonly error: KoiError;
} {
  return {
    ok: false,
    error: {
      code: "VALIDATION",
      message,
      retryable: RETRYABLE_DEFAULTS.VALIDATION,
    },
  };
}

function validateDescriptorOptions(input: unknown): Result<unknown, KoiError> {
  if (input === null || input === undefined || typeof input !== "object") {
    return descriptorValidationError("event-rules options must be an object");
  }
  return validateEventRulesConfig(input);
}

/**
 * Descriptor for event-rules middleware.
 *
 * Creates a declarative event→action middleware from validated YAML options.
 */
export const descriptor: BrickDescriptor<KoiMiddleware> = {
  kind: "middleware",
  name: "@koi/middleware-event-rules",
  aliases: ["event-rules"],
  description: "Declarative YAML rule engine mapping engine events to actions",
  optionsValidator: validateDescriptorOptions,
  factory(options): KoiMiddleware {
    const result = validateEventRulesConfig(options);
    if (!result.ok) {
      throw new Error(`Event rules config validation failed: ${result.error.message}`);
    }
    return createEventRulesMiddleware({ ruleset: result.value });
  },
};
