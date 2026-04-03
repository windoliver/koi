/**
 * Configuration and types for prompt cache middleware.
 */

// CacheHints lives in @koi/execution-context (L0u) so both L2 middleware
// and L2 adapters can import it without peer L2 dependencies.
export type { CacheHints } from "@koi/execution-context";

/**
 * Configuration for the prompt cache middleware.
 */
export interface PromptCacheConfig {
  /** Enable/disable the middleware. Default: true. */
  readonly enabled?: boolean;
  /** Providers to optimize for. Default: ["anthropic", "openai"]. */
  readonly providers?: readonly string[];
  /**
   * Minimum token count for static prefix to be worth caching.
   * Anthropic: 1024 (Sonnet), 2048 (Haiku), 4096 (Opus).
   * OpenAI: 1024 (automatic caching threshold).
   * Default: 1024.
   */
  readonly staticPrefixMinTokens?: number;
}

/** Resolved config with defaults applied. */
export interface ResolvedPromptCacheConfig {
  readonly enabled: boolean;
  readonly providers: readonly string[];
  readonly staticPrefixMinTokens: number;
}

export const DEFAULT_PROMPT_CACHE_CONFIG: ResolvedPromptCacheConfig = {
  enabled: true,
  providers: ["anthropic", "openai"],
  staticPrefixMinTokens: 1024,
} as const;
