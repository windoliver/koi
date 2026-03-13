/**
 * Prompt cache middleware — reorders messages for cache-friendly prefix ordering
 * and emits CacheHints via side-channel for engine adapters.
 *
 * Priority 150 (runs early, before most middleware modifies messages).
 * Phase: "resolve" (modifies the request).
 */

import type {
  CapabilityFragment,
  KoiMiddleware,
  ModelChunk,
  ModelHandler,
  ModelRequest,
  ModelResponse,
  ModelStreamHandler,
  TurnContext,
} from "@koi/core";
import { type CacheHints, PROMPT_CACHE_HINTS } from "@koi/execution-context";
import { extractProvider } from "@koi/name-resolution";
import { estimateTokens, reorderForCache } from "./reorder.js";
import type { PromptCacheConfig, ResolvedPromptCacheConfig } from "./types.js";
import { DEFAULT_PROMPT_CACHE_CONFIG } from "./types.js";

// Re-export for convenience — callers can import from either package
export { PROMPT_CACHE_HINTS } from "@koi/execution-context";

function resolveConfig(config?: PromptCacheConfig): ResolvedPromptCacheConfig {
  if (config === undefined) return DEFAULT_PROMPT_CACHE_CONFIG;
  return {
    enabled: config.enabled ?? DEFAULT_PROMPT_CACHE_CONFIG.enabled,
    providers: config.providers ?? DEFAULT_PROMPT_CACHE_CONFIG.providers,
    staticPrefixMinTokens:
      config.staticPrefixMinTokens ?? DEFAULT_PROMPT_CACHE_CONFIG.staticPrefixMinTokens,
  };
}

function processRequest(request: ModelRequest, resolved: ResolvedPromptCacheConfig): ModelRequest {
  if (!resolved.enabled) return request;

  const provider = extractProvider(request.model ?? "");

  // Skip if provider not in configured list
  if (provider.length > 0 && !resolved.providers.includes(provider)) {
    return request;
  }

  const result = reorderForCache(request.messages);

  // Skip if no static messages to form a prefix
  if (result.staticCount === 0) return request;

  const staticTokens = estimateTokens(result.messages.slice(0, result.staticCount));

  // Skip if static prefix is too small to benefit from caching
  if (staticTokens < resolved.staticPrefixMinTokens) {
    return request;
  }

  // Attach cache hints via side-channel for the engine adapter
  const reorderedRequest: ModelRequest = {
    ...request,
    messages: result.messages,
  };

  const hints: CacheHints = {
    provider: provider.length > 0 ? provider : "unknown",
    lastStableIndex: result.lastStableIndex,
    staticPrefixTokens: staticTokens,
  };
  PROMPT_CACHE_HINTS.set(reorderedRequest, hints);

  return reorderedRequest;
}

/**
 * Create prompt cache optimization middleware.
 *
 * Reorders model request messages so stable content (system prompt, tool definitions)
 * forms a consistent prefix, enabling provider-level prompt caching.
 *
 * Cache hints are attached to the request via a side-channel (`PROMPT_CACHE_HINTS`)
 * that engine adapters read to apply provider-specific markers (e.g., Anthropic's
 * `cache_control: { type: "ephemeral" }`).
 */
export function createPromptCacheMiddleware(config?: PromptCacheConfig): KoiMiddleware {
  const resolved = resolveConfig(config);

  return {
    name: "prompt-cache",
    priority: 150,
    phase: "resolve",

    wrapModelCall(
      _ctx: TurnContext,
      request: ModelRequest,
      next: ModelHandler,
    ): Promise<ModelResponse> {
      return next(processRequest(request, resolved));
    },

    wrapModelStream(
      _ctx: TurnContext,
      request: ModelRequest,
      next: ModelStreamHandler,
    ): AsyncIterable<ModelChunk> {
      return next(processRequest(request, resolved));
    },

    describeCapabilities(): CapabilityFragment | undefined {
      if (!resolved.enabled) return undefined;
      return {
        label: "prompt-cache",
        description: `Prompt caching active for ${resolved.providers.join(", ")}. Static prefix threshold: ${String(resolved.staticPrefixMinTokens)} tokens.`,
      };
    },
  } satisfies KoiMiddleware;
}
