/**
 * BrickDescriptor for @koi/model-router.
 *
 * Enables manifest auto-resolution: validates cascade/fallback/round-robin/weighted
 * routing options from koi.yaml, then creates the model-router middleware.
 *
 * Example koi.yaml:
 * ```yaml
 * middleware:
 *   - model-router:
 *       strategy: cascade
 *       confidenceThreshold: 0.7
 *       targets:
 *         - anthropic:claude-haiku-4-5
 *         - anthropic:claude-sonnet-4-5
 * ```
 */

import type { KoiError, KoiMiddleware, Result } from "@koi/core";
import { RETRYABLE_DEFAULTS } from "@koi/core/errors";
import type { BrickDescriptor, ResolutionContext } from "@koi/resolve";
import { validateRequiredDescriptorOptions } from "@koi/resolve";
import { createAnthropicAdapter } from "./adapters/anthropic.js";
import { createOpenAIAdapter } from "./adapters/openai.js";
import { createOpenRouterAdapter } from "./adapters/openrouter.js";
import { createComplexityClassifier } from "./cascade/complexity-classifier.js";
import {
  composeEvaluators,
  createKeywordEvaluator,
  createLengthHeuristicEvaluator,
} from "./cascade/evaluators.js";
import type { ModelRouterConfig, ModelTargetConfig, RoutingStrategy } from "./config.js";
import { validateRouterConfig } from "./config.js";
import { createModelRouterMiddleware } from "./middleware.js";
import type { ProviderAdapter, ProviderAdapterConfig } from "./provider-adapter.js";
import { createModelRouter } from "./router.js";

// ---------------------------------------------------------------------------
// Provider resolution — maps "provider" to env key + adapter factory
// ---------------------------------------------------------------------------

/** Maps provider names to their expected environment variable for the API key. */
export const PROVIDER_ENV_KEYS: Readonly<Record<string, string>> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
} as const;

/** Maps provider names to their adapter factory functions. */
export const PROVIDER_FACTORIES: Readonly<
  Record<string, (config: ProviderAdapterConfig) => ProviderAdapter>
> = {
  anthropic: createAnthropicAdapter,
  openai: createOpenAIAdapter,
  openrouter: createOpenRouterAdapter,
} as const;

const VALID_STRATEGIES: readonly string[] = [
  "cascade",
  "fallback",
  "round-robin",
  "weighted",
] as const;

// ---------------------------------------------------------------------------
// Validated options — narrowed type after validation passes
// ---------------------------------------------------------------------------

interface ValidatedRouterOptions {
  readonly strategy: RoutingStrategy;
  readonly targets: readonly string[];
  readonly confidenceThreshold?: number | undefined;
  readonly maxEscalations?: number | undefined;
  readonly budgetLimitTokens?: number | undefined;
}

/**
 * Narrows a validated Record into the known option shape.
 * Only called after `validateModelRouterDescriptorOptions` returns `ok: true`,
 * so the type guards in the validator guarantee the shape.
 */
function narrowValidatedOptions(opts: Readonly<Record<string, unknown>>): ValidatedRouterOptions {
  return {
    strategy: opts.strategy as RoutingStrategy,
    targets: opts.targets as readonly string[],
    ...(typeof opts.confidenceThreshold === "number"
      ? { confidenceThreshold: opts.confidenceThreshold }
      : {}),
    ...(typeof opts.maxEscalations === "number" ? { maxEscalations: opts.maxEscalations } : {}),
    ...(typeof opts.budgetLimitTokens === "number"
      ? { budgetLimitTokens: opts.budgetLimitTokens }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// Options validation
// ---------------------------------------------------------------------------

function validateModelRouterDescriptorOptions(
  input: unknown,
): Result<Record<string, unknown>, KoiError> {
  const base = validateRequiredDescriptorOptions(input, "model-router");
  if (!base.ok) return base;
  const opts = base.value;

  // strategy is required
  if (typeof opts.strategy !== "string" || !VALID_STRATEGIES.includes(opts.strategy)) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: `model-router.strategy must be one of: ${VALID_STRATEGIES.join(", ")}`,
        retryable: RETRYABLE_DEFAULTS.VALIDATION,
      },
    };
  }

  // targets is required, must be a non-empty array of "provider:model" strings
  if (!Array.isArray(opts.targets) || opts.targets.length === 0) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "model-router.targets must be a non-empty array of provider:model strings",
        retryable: RETRYABLE_DEFAULTS.VALIDATION,
      },
    };
  }

  for (const target of opts.targets) {
    if (typeof target !== "string") {
      return {
        ok: false,
        error: {
          code: "VALIDATION",
          message: `model-router.targets: invalid target "${String(target)}". Expected "provider:model" format`,
          retryable: RETRYABLE_DEFAULTS.VALIDATION,
        },
      };
    }

    const colonIndex = target.indexOf(":");
    if (colonIndex === -1 || colonIndex === 0 || colonIndex === target.length - 1) {
      return {
        ok: false,
        error: {
          code: "VALIDATION",
          message: `model-router.targets: invalid target "${target}". Provider and model must both be non-empty in "provider:model" format`,
          retryable: RETRYABLE_DEFAULTS.VALIDATION,
        },
      };
    }
  }

  // confidenceThreshold is optional, only for cascade
  if (
    opts.confidenceThreshold !== undefined &&
    (typeof opts.confidenceThreshold !== "number" ||
      opts.confidenceThreshold < 0 ||
      opts.confidenceThreshold > 1)
  ) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "model-router.confidenceThreshold must be a number between 0 and 1",
        retryable: RETRYABLE_DEFAULTS.VALIDATION,
      },
    };
  }

  // maxEscalations is optional
  if (
    opts.maxEscalations !== undefined &&
    (typeof opts.maxEscalations !== "number" || opts.maxEscalations < 0)
  ) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "model-router.maxEscalations must be a non-negative number",
        retryable: RETRYABLE_DEFAULTS.VALIDATION,
      },
    };
  }

  // budgetLimitTokens is optional
  if (
    opts.budgetLimitTokens !== undefined &&
    (typeof opts.budgetLimitTokens !== "number" || opts.budgetLimitTokens < 0)
  ) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "model-router.budgetLimitTokens must be a non-negative number",
        retryable: RETRYABLE_DEFAULTS.VALIDATION,
      },
    };
  }

  return { ok: true, value: opts };
}

// ---------------------------------------------------------------------------
// Target parsing
// ---------------------------------------------------------------------------

interface ParsedTarget {
  readonly provider: string;
  readonly model: string;
}

function parseTarget(target: string): ParsedTarget {
  const colonIndex = target.indexOf(":");
  return {
    provider: target.slice(0, colonIndex),
    model: target.slice(colonIndex + 1),
  };
}

// ---------------------------------------------------------------------------
// Adapter resolution — reuse adapters per unique provider
// ---------------------------------------------------------------------------

function resolveAdapters(
  targets: readonly string[],
  context: ResolutionContext,
): Result<ReadonlyMap<string, ProviderAdapter>, KoiError> {
  const entries: Array<readonly [string, ProviderAdapter]> = [];
  const seen = new Set<string>();

  for (const target of targets) {
    const { provider } = parseTarget(target);

    // Already created
    if (seen.has(provider)) continue;
    seen.add(provider);

    const factory = PROVIDER_FACTORIES[provider];
    if (factory === undefined) {
      return {
        ok: false,
        error: {
          code: "VALIDATION",
          message: `model-router: unknown provider "${provider}". Supported: ${Object.keys(PROVIDER_FACTORIES).join(", ")}`,
          retryable: RETRYABLE_DEFAULTS.VALIDATION,
        },
      };
    }

    const envKey = PROVIDER_ENV_KEYS[provider];
    if (envKey === undefined) {
      return {
        ok: false,
        error: {
          code: "VALIDATION",
          message: `model-router: no env key configured for provider "${provider}"`,
          retryable: RETRYABLE_DEFAULTS.VALIDATION,
        },
      };
    }

    const apiKey = context.env[envKey];
    if (apiKey === undefined || apiKey === "") {
      return {
        ok: false,
        error: {
          code: "VALIDATION",
          message: `model-router: missing API key. Set ${envKey} for provider "${provider}"`,
          retryable: RETRYABLE_DEFAULTS.VALIDATION,
        },
      };
    }

    entries.push([provider, factory({ apiKey })]);
  }

  return { ok: true, value: new Map(entries) };
}

// ---------------------------------------------------------------------------
// Router config construction
// ---------------------------------------------------------------------------

function createRouterConfigFromOptions(opts: ValidatedRouterOptions): ModelRouterConfig {
  const { targets, strategy } = opts;
  const confidenceThreshold = opts.confidenceThreshold ?? 0.7;

  const modelTargets: readonly ModelTargetConfig[] = targets.map((t) => {
    const { provider, model } = parseTarget(t);
    return {
      provider,
      model,
      adapterConfig: {},
    };
  });

  const config: ModelRouterConfig = {
    targets: modelTargets,
    strategy,
    ...(strategy === "cascade"
      ? {
          cascade: {
            tiers: targets.map((t) => ({ targetId: t })),
            confidenceThreshold,
            ...(opts.maxEscalations !== undefined ? { maxEscalations: opts.maxEscalations } : {}),
            ...(opts.budgetLimitTokens !== undefined
              ? { budgetLimitTokens: opts.budgetLimitTokens }
              : {}),
          },
        }
      : {}),
  };

  return config;
}

// ---------------------------------------------------------------------------
// Descriptor
// ---------------------------------------------------------------------------

/**
 * Descriptor for model-router middleware.
 *
 * Wires cascade routing (or fallback/round-robin/weighted) from YAML config.
 * Auto-creates complexity classifier + evaluator for cascade strategy.
 */
export const descriptor: BrickDescriptor<KoiMiddleware> = {
  kind: "middleware",
  name: "@koi/model-router",
  aliases: ["model-router"],
  description: "Multi-provider LLM routing with cascade escalation, fallback, and circuit breakers",
  tags: ["routing", "cascade", "multi-model"],
  optionsValidator: validateModelRouterDescriptorOptions,
  factory(options, context): KoiMiddleware {
    // Re-validate to get proven shape (BrickFactory receives JsonObject)
    const validated = validateModelRouterDescriptorOptions(options);
    if (!validated.ok) {
      throw new Error(validated.error.message, { cause: validated.error });
    }
    const opts = narrowValidatedOptions(validated.value);

    // Resolve adapters from env
    const adapterResult = resolveAdapters(opts.targets, context);
    if (!adapterResult.ok) {
      throw new Error(adapterResult.error.message, { cause: adapterResult.error });
    }

    // Build router config
    const routerConfig = createRouterConfigFromOptions(opts);

    // Validate via existing validateRouterConfig
    const validatedConfig = validateRouterConfig(routerConfig);
    if (!validatedConfig.ok) {
      throw new Error(validatedConfig.error.message, { cause: validatedConfig.error });
    }

    // For cascade: auto-create classifier + evaluator
    const routerOptions =
      opts.strategy === "cascade"
        ? {
            classifier: createComplexityClassifier(),
            evaluator: composeEvaluators(
              [createLengthHeuristicEvaluator(), createKeywordEvaluator()],
              "min",
            ),
          }
        : {};

    // Create router and wrap as middleware
    const router = createModelRouter(validatedConfig.value, adapterResult.value, routerOptions);
    return createModelRouterMiddleware(router);
  },
};
