/**
 * Resolves the search section of a manifest.
 *
 * Supports both string shorthand (`search: "brave"`) and object form
 * (`search: { name: "brave", options: { country: "US" } }`).
 * If no search is declared, returns undefined (no web search capability).
 */

import type { KoiError, Result } from "@koi/core";
import type { SearchProvider } from "@koi/search-provider";
import { resolveOne } from "./resolve-one.js";
import type { ResolutionContext, ResolveRegistry } from "./types.js";

/**
 * Resolves a search provider from a manifest.
 *
 * Returns undefined if no search is declared.
 * Accepts `unknown` because the manifest schema may not fully type this section.
 */
export async function resolveSearch(
  config: unknown,
  registry: ResolveRegistry,
  context: ResolutionContext,
): Promise<Result<SearchProvider | undefined, KoiError>> {
  if (config === undefined || config === null) {
    return { ok: true, value: undefined };
  }

  // String shorthand: "brave" → { name: "brave" }
  if (typeof config === "string") {
    const result = await resolveOne<SearchProvider>("search", { name: config }, registry, context);
    return result.ok ? { ok: true, value: result.value } : result;
  }

  if (typeof config !== "object" || !("name" in config) || typeof config.name !== "string") {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "search config must be a string or an object with a 'name' string field",
        retryable: false,
      },
    };
  }

  // config is narrowed to `object & { name: string }` — access via Record for options
  const obj = config as Record<string, unknown>;
  const name = config.name;
  const options =
    typeof obj.options === "object" && obj.options !== null
      ? (obj.options as Record<string, unknown>)
      : undefined;

  const descriptor = options !== undefined ? { name, options } : { name };

  const result = await resolveOne<SearchProvider>("search", descriptor, registry, context);

  if (!result.ok) {
    return result;
  }

  return { ok: true, value: result.value };
}
