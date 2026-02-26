/**
 * Model section resolver.
 *
 * Parses "provider:model" format from manifest, looks up the provider
 * descriptor in the registry, and creates a ModelHandler.
 */

import type { KoiError, ModelConfig, ModelHandler, Result } from "@koi/core";
import { RETRYABLE_DEFAULTS } from "@koi/core/errors";
import { findClosestName } from "./errors.js";
import type { ResolutionContext, ResolveRegistry } from "./types.js";

/**
 * Parses a model name in "provider:model" format.
 */
export function parseModelName(
  name: string,
): Result<{ readonly provider: string; readonly model: string }, KoiError> {
  const colonIndex = name.indexOf(":");
  if (colonIndex === -1) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: `Invalid model name "${name}". Expected format "provider:model" (e.g., "anthropic:claude-sonnet-4-5-20250929").`,
        retryable: RETRYABLE_DEFAULTS.VALIDATION,
      },
    };
  }

  const provider = name.slice(0, colonIndex);
  const model = name.slice(colonIndex + 1);

  if (provider === "" || model === "") {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: `Invalid model name "${name}". Both provider and model must be non-empty.`,
        retryable: RETRYABLE_DEFAULTS.VALIDATION,
      },
    };
  }

  return { ok: true, value: { provider, model } };
}

/**
 * Resolves a model configuration into a ModelHandler.
 *
 * - Parses "provider:model" from config.name
 * - Looks up provider descriptor in registry
 * - Factory receives (config.options ?? {}, context) and returns ModelHandler
 */
export async function resolveModel(
  config: ModelConfig,
  registry: ResolveRegistry,
  context: ResolutionContext,
): Promise<Result<ModelHandler, KoiError>> {
  // Parse model name
  const parsed = parseModelName(config.name);
  if (!parsed.ok) {
    return parsed;
  }

  const { provider, model } = parsed.value;

  // Look up provider descriptor
  const descriptor = registry.get("model", provider);
  if (descriptor === undefined) {
    const available = registry.list("model").map((d) => d.name);
    const suggestion = findClosestName(provider, available);
    const hint = suggestion !== undefined ? ` Did you mean "${suggestion}"?` : "";

    return {
      ok: false,
      error: {
        code: "NOT_FOUND",
        message: `Unknown model provider "${provider}". Available: [${available.join(", ")}].${hint}`,
        retryable: RETRYABLE_DEFAULTS.NOT_FOUND,
        context: { provider, model, available },
      },
    };
  }

  // Validate options
  const options = config.options ?? {};
  const validationResult = descriptor.optionsValidator(options);
  if (!validationResult.ok) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: `Invalid options for model provider "${provider}": ${validationResult.error.message}`,
        retryable: RETRYABLE_DEFAULTS.VALIDATION,
        cause: validationResult.error,
      },
    };
  }

  // Inject model name into options so the factory knows which model to use
  const factoryOptions: Record<string, unknown> = { ...options, model };

  // Call factory — registry returns BrickDescriptor<unknown>, narrow to ModelHandler
  try {
    const handler = (await descriptor.factory(factoryOptions, context)) as ModelHandler;
    return { ok: true, value: handler };
  } catch (e: unknown) {
    return {
      ok: false,
      error: {
        code: "INTERNAL",
        message: `Model provider "${provider}" factory threw: ${e instanceof Error ? e.message : String(e)}`,
        retryable: RETRYABLE_DEFAULTS.INTERNAL,
        cause: e,
      },
    };
  }
}
