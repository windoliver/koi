/**
 * BrickDescriptor for @koi/middleware-tool-selector.
 *
 * Enables manifest auto-resolution: validates tool selector config,
 * then creates the tool selector middleware with a basic keyword-matching
 * selectTools implementation for YAML-driven use.
 */

import type { KoiError, KoiMiddleware, Result } from "@koi/core";
import { RETRYABLE_DEFAULTS } from "@koi/core/errors";
import type { BrickDescriptor } from "@koi/resolve";
import { extractLastUserText } from "./extract-query.js";
import { createToolSelectorMiddleware } from "./tool-selector.js";

function validateToolSelectorDescriptorOptions(input: unknown): Result<unknown, KoiError> {
  if (input === null || input === undefined || typeof input !== "object") {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "Tool selector options must be an object",
        retryable: RETRYABLE_DEFAULTS.VALIDATION,
      },
    };
  }

  const opts = input as Record<string, unknown>;

  if (opts.maxTools !== undefined && (typeof opts.maxTools !== "number" || opts.maxTools <= 0)) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "tool-selector.maxTools must be a positive number",
        retryable: RETRYABLE_DEFAULTS.VALIDATION,
      },
    };
  }

  return { ok: true, value: input };
}

/**
 * Default selectTools: keyword-based matching on tool name and description.
 * Splits the query into terms and scores tools by keyword overlap.
 */
async function defaultSelectTools(
  query: string,
  tools: readonly { readonly name: string; readonly description?: string }[],
): Promise<readonly string[]> {
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 2);
  if (terms.length === 0) return tools.map((t) => t.name);

  const scored = tools.map((tool) => {
    const haystack = `${tool.name} ${tool.description ?? ""}`.toLowerCase();
    const score = terms.reduce((acc, term) => acc + (haystack.includes(term) ? 1 : 0), 0);
    return { name: tool.name, score };
  });

  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((s) => s.name);
}

/**
 * Descriptor for tool-selector middleware.
 * Exported for registration with createRegistry().
 */
export const descriptor: BrickDescriptor<KoiMiddleware> = {
  kind: "middleware",
  name: "@koi/middleware-tool-selector",
  aliases: ["tool-selector"],
  optionsValidator: validateToolSelectorDescriptorOptions,
  factory(options): KoiMiddleware {
    const maxTools = typeof options.maxTools === "number" ? options.maxTools : undefined;

    const config: Parameters<typeof createToolSelectorMiddleware>[0] = {
      selectTools: defaultSelectTools,
      extractQuery: extractLastUserText,
    };

    if (maxTools !== undefined) {
      return createToolSelectorMiddleware({ ...config, maxTools });
    }

    return createToolSelectorMiddleware(config);
  },
};
