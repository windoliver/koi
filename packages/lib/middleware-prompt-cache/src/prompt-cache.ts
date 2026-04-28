/**
 * Prompt-cache middleware — reorders messages for cache-friendly prefix
 * ordering and attaches CacheHints in request.metadata so engine adapters
 * can apply provider-specific cache markers.
 *
 * Optimization-only: the message set sent to the model is identical, only the
 * order of static messages relative to dynamic messages is changed. Adapters
 * that don't understand the metadata key ignore it.
 */

import type {
  CapabilityFragment,
  InboundMessage,
  JsonObject,
  KoiMiddleware,
  ModelChunk,
  ModelHandler,
  ModelRequest,
  ModelResponse,
  ModelStreamHandler,
  TurnContext,
} from "@koi/core";
import type { CacheHints } from "@koi/execution-context";
import { CHARS_PER_TOKEN } from "@koi/token-estimator";

import { reorderForCache } from "./reorder.js";
import type { PromptCacheConfig, ResolvedPromptCacheConfig } from "./types.js";
import { DEFAULT_PROMPT_CACHE_CONFIG } from "./types.js";

const MIDDLEWARE_PRIORITY = 150;

// Per-message overhead added by HEURISTIC_ESTIMATOR for role/separator framing.
// Mirrors @koi/token-estimator default so prefix-budget math matches the rest
// of the system. We inline the loop (instead of calling
// HEURISTIC_ESTIMATOR.estimateMessages) because the L0 TokenEstimator contract
// permits async implementations — the prompt-cache transform must be sync to
// preserve wrapModelStream's AsyncIterable return type.
const PER_MESSAGE_OVERHEAD = 4;
const PER_NON_TEXT_BLOCK_OVERHEAD = 100;

function estimatePrefixTokens(messages: readonly InboundMessage[]): number {
  let total = 0; // let: accumulator
  for (const msg of messages) {
    total += PER_MESSAGE_OVERHEAD;
    for (const block of msg.content) {
      if (block.kind === "text") total += Math.ceil(block.text.length / CHARS_PER_TOKEN);
      else total += PER_NON_TEXT_BLOCK_OVERHEAD;
    }
  }
  return total;
}

/**
 * Metadata key on ModelRequest carrying the cache hints. Stored in
 * request.metadata (not a WeakMap) so the entry survives object-spread
 * cloning by downstream middleware.
 */
export const CACHE_HINTS_KEY = "__koi_cache_hints__" as const;

/** Read cache hints written by this middleware from a request's metadata. */
export function readCacheHints(metadata: JsonObject | undefined): CacheHints | undefined {
  if (metadata === undefined) return undefined;
  const raw = metadata[CACHE_HINTS_KEY];
  if (raw === undefined || typeof raw !== "object" || raw === null) return undefined;
  return raw as unknown as CacheHints;
}

/**
 * Best-effort provider extraction from a model identifier.
 * Returns "" when the model is empty/unrecognized so the caller can
 * distinguish "unknown" from "known-but-not-allow-listed".
 */
function extractProvider(modelId: string): string {
  if (modelId.length === 0) return "";
  if (modelId.startsWith("claude-")) return "anthropic";
  if (
    modelId.startsWith("gpt-") ||
    modelId.startsWith("o1") ||
    modelId.startsWith("o3") ||
    modelId.startsWith("o4")
  )
    return "openai";
  if (modelId.startsWith("gemini-")) return "google";
  return "";
}

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

  // Known provider not in allow-list → skip. Empty/unknown provider → still
  // attach hints; adapters that understand them benefit, others ignore.
  if (provider.length > 0 && !resolved.providers.includes(provider)) {
    return request;
  }

  const result = reorderForCache(request.messages);
  if (result.staticCount === 0) return request;

  const staticTokens = estimatePrefixTokens(result.messages.slice(0, result.staticCount));
  if (staticTokens < resolved.staticPrefixMinTokens) return request;

  const hints: CacheHints = {
    provider: provider.length > 0 ? provider : "unknown",
    lastStableIndex: result.lastStableIndex,
    staticPrefixTokens: staticTokens,
  };

  return {
    ...request,
    messages: result.messages,
    metadata: {
      ...request.metadata,
      [CACHE_HINTS_KEY]: hints as unknown as JsonObject,
    },
  };
}

export function createPromptCacheMiddleware(config?: PromptCacheConfig): KoiMiddleware {
  const resolved = resolveConfig(config);

  return {
    name: "prompt-cache",
    priority: MIDDLEWARE_PRIORITY,
    phase: "resolve",

    describeCapabilities(): CapabilityFragment | undefined {
      if (!resolved.enabled) return undefined;
      return {
        label: "prompt-cache",
        description: `Prompt caching active for ${resolved.providers.join(", ")}; static prefix threshold ${String(resolved.staticPrefixMinTokens)} tokens.`,
      };
    },

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
  };
}
