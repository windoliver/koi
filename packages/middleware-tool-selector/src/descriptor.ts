/**
 * BrickDescriptor for @koi/middleware-tool-selector.
 *
 * Enables manifest auto-resolution: validates tool selector config from
 * YAML options, then creates the middleware. Supports four modes:
 * - No profile, no tags: keyword-based defaultSelectTools (backward compatible)
 * - tags/exclude: tag-based selectTools (deterministic filtering)
 * - profile: named tool profile (static filtering)
 * - profile + autoScale: model-capability-aware dynamic profiles
 */

import type { KoiError, KoiMiddleware, Result, ToolDescriptor } from "@koi/core";
import { RETRYABLE_DEFAULTS } from "@koi/core/errors";
import type { BrickDescriptor, ResolutionContext } from "@koi/resolve";
import { validateRequiredDescriptorOptions } from "@koi/resolve";
import type { ToolSelectorConfig } from "./config.js";
import { extractLastUserText } from "./extract-query.js";
import { detectModelTier } from "./model-tier.js";
import { isToolProfileName } from "./tool-profiles.js";
import { createToolSelectorMiddleware } from "./tool-selector.js";

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((x) => typeof x === "string");
}

function validateToolSelectorDescriptorOptions(
  input: unknown,
): Result<Record<string, unknown>, KoiError> {
  const base = validateRequiredDescriptorOptions(input, "Tool selector");
  if (!base.ok) return base;
  const opts = base.value;

  if (
    opts.maxTools !== undefined &&
    (typeof opts.maxTools !== "number" || opts.maxTools <= 0 || !Number.isInteger(opts.maxTools))
  ) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "tool-selector.maxTools must be a positive integer",
        retryable: RETRYABLE_DEFAULTS.VALIDATION,
      },
    };
  }

  if (opts.tags !== undefined && !isStringArray(opts.tags)) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "tool-selector.tags must be an array of strings",
        retryable: RETRYABLE_DEFAULTS.VALIDATION,
      },
    };
  }

  if (opts.exclude !== undefined && !isStringArray(opts.exclude)) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "tool-selector.exclude must be an array of strings",
        retryable: RETRYABLE_DEFAULTS.VALIDATION,
      },
    };
  }

  if (
    opts.minTools !== undefined &&
    (typeof opts.minTools !== "number" || opts.minTools < 0 || !Number.isInteger(opts.minTools))
  ) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "tool-selector.minTools must be a non-negative integer",
        retryable: RETRYABLE_DEFAULTS.VALIDATION,
      },
    };
  }

  if (opts.alwaysInclude !== undefined && !isStringArray(opts.alwaysInclude)) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "tool-selector.alwaysInclude must be an array of strings",
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

  return { ok: true, value: opts };
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
 * Creates a tag-based selectTools function.
 *
 * - Include: tool must have ALL specified includeTags (AND semantics)
 * - Exclude: tool must have NONE of specified excludeTags (ANY match removes)
 * - Tools without tags are excluded when includeTags is specified
 * - Ignores query — filtering is deterministic, not query-dependent
 */
export function createTagSelectTools(
  includeTags: readonly string[] | undefined,
  excludeTags: readonly string[] | undefined,
): (query: string, tools: readonly ToolDescriptor[]) => Promise<readonly string[]> {
  return async (_query: string, tools: readonly ToolDescriptor[]): Promise<readonly string[]> => {
    return tools
      .filter((tool) => {
        const toolTags = tool.tags;

        // Include filter: tool must have ALL specified tags
        if (includeTags !== undefined && includeTags.length > 0) {
          if (toolTags === undefined) return false;
          const hasAll = includeTags.every((tag) => toolTags.includes(tag));
          if (!hasAll) return false;
        }

        // Exclude filter: tool must have NONE of specified tags
        if (excludeTags !== undefined && excludeTags.length > 0) {
          if (toolTags !== undefined) {
            const hasAny = excludeTags.some((tag) => toolTags.includes(tag));
            if (hasAny) return false;
          }
        }

        return true;
      })
      .map((t) => t.name);
  };
}

/**
 * Builds a ToolSelectorConfig from YAML options and resolution context.
 */
function createConfigFromOptions(
  options: Record<string, unknown>,
  context: ResolutionContext,
): ToolSelectorConfig {
  const maxTools = typeof options.maxTools === "number" ? options.maxTools : undefined;
  const minTools = typeof options.minTools === "number" ? options.minTools : undefined;

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
        ...(minTools !== undefined ? { minTools } : {}),
      } as ToolSelectorConfig;
    }

    // Profile mode
    return {
      profile: options.profile as string,
      include,
      exclude,
      ...(maxTools !== undefined ? { maxTools } : {}),
      ...(minTools !== undefined ? { minTools } : {}),
    } as ToolSelectorConfig;
  }

  // Tag-based filtering mode: when tags or exclude specified (but no profile)
  const tags = isStringArray(options.tags) ? options.tags : undefined;
  const exclude = isStringArray(options.exclude) ? options.exclude : undefined;
  const alwaysInclude = isStringArray(options.alwaysInclude) ? options.alwaysInclude : undefined;
  const useTagFiltering =
    (tags !== undefined && tags.length > 0) || (exclude !== undefined && exclude.length > 0);

  if (useTagFiltering) {
    return {
      selectTools: createTagSelectTools(tags, exclude),
      extractQuery: extractLastUserText,
      ...(alwaysInclude !== undefined ? { alwaysInclude } : {}),
      ...(maxTools !== undefined ? { maxTools } : {}),
      ...(minTools !== undefined ? { minTools } : {}),
    };
  }

  // Custom mode (backward compatible): keyword-based default
  return {
    selectTools: defaultSelectTools,
    extractQuery: extractLastUserText,
    ...(alwaysInclude !== undefined ? { alwaysInclude } : {}),
    ...(maxTools !== undefined ? { maxTools } : {}),
    ...(minTools !== undefined ? { minTools } : {}),
  };
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
