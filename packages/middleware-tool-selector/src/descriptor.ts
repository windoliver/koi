/**
 * BrickDescriptor for @koi/middleware-tool-selector.
 *
 * Enables manifest auto-resolution: validates tool selector config from
 * YAML options, then creates the middleware. Supports three modes:
 * - No profile: keyword-based defaultSelectTools (backward compatible)
 * - profile: named tool profile (static filtering)
 * - profile + autoScale: model-capability-aware dynamic profiles
 */

import type { KoiError, KoiMiddleware, Result } from "@koi/core";
import { RETRYABLE_DEFAULTS } from "@koi/core/errors";
import type { BrickDescriptor, ResolutionContext } from "@koi/resolve";
import type { ToolSelectorConfig } from "./config.js";
import { extractLastUserText } from "./extract-query.js";
import { detectModelTier } from "./model-tier.js";
import { isToolProfileName } from "./tool-profiles.js";
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

  // Validate profile name if present
  if (opts.profile !== undefined && opts.profile !== "auto" && !isToolProfileName(opts.profile)) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: `tool-selector.profile '${String(opts.profile)}' is not a valid profile name`,
        retryable: RETRYABLE_DEFAULTS.VALIDATION,
      },
    };
  }

  // profile: "auto" requires autoScale: true
  if (opts.profile === "auto" && opts.autoScale !== true) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "tool-selector.profile 'auto' requires autoScale: true",
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
 * Builds a ToolSelectorConfig from YAML options and resolution context.
 */
function createConfigFromOptions(
  options: Record<string, unknown>,
  context: ResolutionContext,
): ToolSelectorConfig {
  const maxTools = typeof options.maxTools === "number" ? options.maxTools : undefined;

  // Profile mode or auto mode
  if (typeof options.profile === "string") {
    const include = Array.isArray(options.include)
      ? (options.include as readonly string[])
      : undefined;
    const exclude = Array.isArray(options.exclude)
      ? (options.exclude as readonly string[])
      : undefined;

    if (options.autoScale === true) {
      // Auto mode: detect model tier from manifest
      const modelName = context.manifest.model.name;
      const tier = detectModelTier(modelName);

      return {
        profile: options.profile as "auto" | (typeof options.profile & string),
        autoScale: true,
        tier,
        include,
        exclude,
        ...(maxTools !== undefined ? { maxTools } : {}),
      } as ToolSelectorConfig;
    }

    // Profile mode
    return {
      profile: options.profile as string,
      include,
      exclude,
      ...(maxTools !== undefined ? { maxTools } : {}),
    } as ToolSelectorConfig;
  }

  // Custom mode (backward compatible): keyword-based default
  const config: ToolSelectorConfig = {
    selectTools: defaultSelectTools,
    extractQuery: extractLastUserText,
    ...(maxTools !== undefined ? { maxTools } : {}),
  };

  return config;
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
  factory(options, context): KoiMiddleware {
    const opts = options as Record<string, unknown>;
    const config = createConfigFromOptions(opts, context);
    return createToolSelectorMiddleware(config);
  },
};
