/**
 * Shared model resolution for `koi serve` and `koi start`.
 *
 * Parses `manifest.model.name` (e.g., "anthropic:claude-sonnet-4-5-20250929"),
 * looks up the API key from the environment, creates the provider adapter,
 * and returns a `ModelHandler` ready for `createLoopAdapter`.
 */

import type { AgentManifest, ModelHandler } from "@koi/core";
import type { ProviderAdapter, ProviderAdapterConfig } from "@koi/model-router";
import {
  createAnthropicAdapter,
  createOpenAIAdapter,
  createOpenRouterAdapter,
} from "@koi/model-router";

// ---------------------------------------------------------------------------
// Provider → environment variable mapping
// ---------------------------------------------------------------------------

const PROVIDER_ENV_KEYS: Readonly<Record<string, string>> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
} as const;

// ---------------------------------------------------------------------------
// Provider → adapter factory mapping
// ---------------------------------------------------------------------------

const PROVIDER_FACTORIES: Readonly<
  Record<string, (config: ProviderAdapterConfig) => ProviderAdapter>
> = {
  anthropic: createAnthropicAdapter,
  openai: createOpenAIAdapter,
  openrouter: createOpenRouterAdapter,
} as const;

const SUPPORTED_PROVIDERS = Object.keys(PROVIDER_FACTORIES);

// ---------------------------------------------------------------------------
// Model name parsing
// ---------------------------------------------------------------------------

interface ParsedModel {
  readonly provider: string;
  readonly model: string;
}

export function parseModelName(name: string): ParsedModel {
  const colonIndex = name.indexOf(":");
  if (colonIndex === -1) {
    throw new Error(
      `Invalid model name "${name}". Expected format "provider:model" (e.g., "anthropic:claude-sonnet-4-5-20250929").`,
    );
  }

  const provider = name.slice(0, colonIndex);
  const model = name.slice(colonIndex + 1);

  if (provider === "" || model === "") {
    throw new Error(
      `Invalid model name "${name}". Both provider and model must be non-empty (e.g., "anthropic:claude-sonnet-4-5-20250929").`,
    );
  }

  return { provider, model };
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export function resolveModelCall(manifest: AgentManifest): ModelHandler {
  const { provider, model } = parseModelName(manifest.model.name);

  // Validate provider
  const factory = PROVIDER_FACTORIES[provider];
  if (factory === undefined) {
    throw new Error(
      `Unknown model provider "${provider}". Supported providers: ${SUPPORTED_PROVIDERS.join(", ")}.`,
    );
  }

  // Resolve API key from environment
  const envKey = PROVIDER_ENV_KEYS[provider];
  if (envKey === undefined) {
    throw new Error(
      `No environment variable configured for provider "${provider}". Supported providers: ${SUPPORTED_PROVIDERS.join(", ")}.`,
    );
  }

  const apiKey = process.env[envKey];
  if (apiKey === undefined || apiKey === "") {
    throw new Error(
      `Missing API key. Set the ${envKey} environment variable to use provider "${provider}".`,
    );
  }

  // Create adapter
  const adapter = factory({ apiKey });

  // Wrap as ModelHandler, injecting the model name into every request
  return async (request) => adapter.complete({ ...request, model });
}
