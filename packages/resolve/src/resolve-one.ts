/**
 * Single-item resolver — shared by all per-section resolvers.
 *
 * Looks up a descriptor from the registry, validates options,
 * and calls the factory.
 */

import type { JsonObject, KoiError, Result } from "@koi/core";
import { RETRYABLE_DEFAULTS } from "@koi/core/errors";
import { findClosestName } from "./errors.js";
import type { BrickDescriptor, ResolutionContext, ResolveKind, ResolveRegistry } from "./types.js";

/**
 * Resolves a single brick from the registry.
 *
 * 1. Looks up descriptor by (kind, name)
 * 2. Validates options via descriptor.optionsValidator
 * 3. Calls descriptor.factory with validated options + context
 */
export async function resolveOne<T>(
  kind: ResolveKind,
  config: { readonly name: string; readonly options?: JsonObject },
  registry: ResolveRegistry,
  context: ResolutionContext,
): Promise<Result<T, KoiError>> {
  // 1. Look up descriptor
  const descriptor = registry.get(kind, config.name);

  if (descriptor === undefined) {
    const available = registry.list(kind).map((d) => d.name);
    const suggestion = findClosestName(config.name, available);
    const hint = suggestion !== undefined ? ` Did you mean "${suggestion}"?` : "";

    return {
      ok: false,
      error: {
        code: "NOT_FOUND",
        message: `${kind} "${config.name}" not found in registry. Available: [${available.join(", ")}].${hint}`,
        retryable: RETRYABLE_DEFAULTS.NOT_FOUND,
        context: { kind, name: config.name, available },
      },
    };
  }

  // 2. Validate options
  const validationResult = descriptor.optionsValidator(config.options ?? {});
  if (!validationResult.ok) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: `Invalid options for ${kind} "${config.name}": ${validationResult.error.message}`,
        retryable: RETRYABLE_DEFAULTS.VALIDATION,
        cause: validationResult.error,
      },
    };
  }

  // 3. Call factory
  const EMPTY_OPTIONS: JsonObject = {};
  try {
    // Generic cast: registry returns BrickDescriptor<unknown>, caller narrows via T
    const typedDescriptor = descriptor as BrickDescriptor<T>;
    const instance = await typedDescriptor.factory(config.options ?? EMPTY_OPTIONS, context);
    return { ok: true, value: instance };
  } catch (e: unknown) {
    return {
      ok: false,
      error: {
        code: "INTERNAL",
        message: `Factory for ${kind} "${config.name}" threw: ${e instanceof Error ? e.message : String(e)}`,
        retryable: RETRYABLE_DEFAULTS.INTERNAL,
        cause: e,
      },
    };
  }
}
