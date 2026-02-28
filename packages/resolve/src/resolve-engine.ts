/**
 * Resolves the engine section of a manifest.
 *
 * If no engine is declared, returns undefined (CLI defaults to loop adapter).
 * Otherwise, resolves the engine by name via the registry.
 * Accepts both string shorthand ("external") and object form ({ name: "external", options: {...} }).
 */

import type { EngineAdapter, KoiError, Result } from "@koi/core";
import { resolveOne } from "./resolve-one.js";
import type { ResolutionContext, ResolveRegistry } from "./types.js";

/** Engine config shape as it appears in the manifest. */
interface EngineConfig {
  readonly name: string;
  readonly options?: Record<string, unknown>;
}

/**
 * Resolves the engine adapter from a manifest.
 *
 * Returns undefined if no engine is declared (CLI falls back to defaults).
 * Accepts `unknown` because the manifest schema may not fully type this section.
 */
export async function resolveEngine(
  config: unknown,
  registry: ResolveRegistry,
  context: ResolutionContext,
): Promise<Result<EngineAdapter | undefined, KoiError>> {
  if (config === undefined || config === null) {
    return { ok: true, value: undefined };
  }

  // String shorthand: "external" → { name: "external" }
  if (typeof config === "string") {
    const result = await resolveOne<EngineAdapter>("engine", { name: config }, registry, context);
    return result.ok ? { ok: true, value: result.value } : result;
  }

  if (typeof config !== "object" || !("name" in config) || typeof config.name !== "string") {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "engine config must be a string or an object with a 'name' string field",
        retryable: false,
      },
    };
  }

  const typed = config as EngineConfig;
  const descriptor =
    typed.options !== undefined
      ? { name: typed.name, options: typed.options }
      : { name: typed.name };

  const result = await resolveOne<EngineAdapter>("engine", descriptor, registry, context);

  if (!result.ok) {
    return result;
  }

  return { ok: true, value: result.value };
}
