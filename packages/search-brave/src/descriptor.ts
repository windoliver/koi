/**
 * BrickDescriptor for @koi/search-brave.
 *
 * Enables manifest auto-resolution for Brave Search as a search provider.
 * Reads BRAVE_API_KEY from context.env.
 */

import type { KoiError, Result } from "@koi/core";
import { RETRYABLE_DEFAULTS } from "@koi/core/errors";
import type { BrickDescriptor } from "@koi/resolve";
import type { SearchProvider } from "@koi/search-provider";
import { createBraveSearch } from "./brave-search.js";

function validateBraveSearchOptions(input: unknown): Result<unknown, KoiError> {
  // Options are optional — pass through whatever is provided
  if (input === null || input === undefined) {
    return { ok: true, value: {} };
  }

  if (typeof input !== "object") {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "Brave search options must be an object",
        retryable: RETRYABLE_DEFAULTS.VALIDATION,
      },
    };
  }

  return { ok: true, value: input };
}

/**
 * Descriptor for Brave Search provider.
 * Exported for registration with createRegistry().
 */
export const descriptor: BrickDescriptor<SearchProvider> = {
  kind: "search",
  name: "@koi/search-brave",
  aliases: ["brave"],
  description: "Brave Search API web search provider",
  tags: ["search", "web", "brave"],
  optionsValidator: validateBraveSearchOptions,
  factory(options, context): SearchProvider {
    const apiKey = context.env.BRAVE_API_KEY;
    if (!apiKey) {
      throw new Error("BRAVE_API_KEY environment variable is required but not set");
    }

    return createBraveSearch({
      apiKey,
      ...(typeof options.country === "string" ? { country: options.country } : {}),
      ...(typeof options.freshness === "string" ? { freshness: options.freshness } : {}),
      ...(typeof options.timeoutMs === "number" ? { timeoutMs: options.timeoutMs } : {}),
      ...(typeof options.baseUrl === "string" ? { baseUrl: options.baseUrl } : {}),
    });
  },
};
