/**
 * Top-level validators composing Zod schema + semantic checks.
 */

import type { KoiError, Result } from "@koi/core";
import type { CanvasConfig } from "./config.js";
import { validateA2uiMessageSchema, validateCreateSurfaceSchema } from "./schemas.js";
import type { A2uiComponent, A2uiCreateSurface, A2uiMessage } from "./types.js";
import { isValidJsonPointer } from "./validate-data-model.js";
import { validateSurfaceComponents } from "./validate-surface.js";

/**
 * Validates a raw A2UI message (Zod schema only, no semantic checks).
 *
 * Zod validates structure; branded types are applied via cast since
 * the schema guarantees string content matches the branded type shape.
 */
export function validateA2uiMessage(raw: unknown): Result<A2uiMessage, KoiError> {
  const result = validateA2uiMessageSchema(raw);
  if (!result.ok) return result;
  // Safe cast: Zod validated the shape, branded types are string-based
  return { ok: true, value: result.value as A2uiMessage };
}

/**
 * Validates a createSurface message with both Zod schema and semantic checks.
 */
export function validateCreateSurface(
  raw: unknown,
  config?: Partial<CanvasConfig>,
): Result<A2uiCreateSurface, KoiError> {
  // Step 1: Zod schema validation
  const schemaResult = validateCreateSurfaceSchema(raw);
  if (!schemaResult.ok) return schemaResult;

  // Safe cast: Zod validated the shape, branded types are string-based
  const msg = schemaResult.value as A2uiCreateSurface;

  // Step 2: Semantic validation on components
  const componentResult = validateSurfaceComponents(
    msg.components as readonly A2uiComponent[],
    config,
  );
  if (!componentResult.ok) return componentResult;

  // Step 3: Validate data model pointers (if data bindings exist)
  for (const comp of msg.components) {
    if (comp.dataBinding !== undefined) {
      if (!isValidJsonPointer(comp.dataBinding)) {
        return {
          ok: false,
          error: {
            code: "VALIDATION",
            message: `Invalid data binding JSON Pointer "${comp.dataBinding}" on component "${comp.id as string}"`,
            retryable: false,
            context: { componentId: comp.id as string, pointer: comp.dataBinding },
          },
        };
      }
    }
  }

  return { ok: true, value: msg };
}
